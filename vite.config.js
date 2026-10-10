import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const r = (p) => resolve(root, p);

// 复制 manifest.json 与非打包静态资源（icons、vendor）到 dist。
// manifest 内部使用的相对路径（src/background.js / src/content.js /
// src/injected/*.js / icons/* / src/sidepanel/sidepanel.html）与构建产物保持一致，
// 因此无需改写 manifest，Chrome 直接加载 dist 即可。
function copyExtensionAssets() {
  let outDir = "dist";
  return {
    name: "copy-extension-assets",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const copyDir = (src, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const s = resolve(src, entry.name);
          const d = resolve(dest, entry.name);
          if (entry.isDirectory()) copyDir(s, d);
          else fs.copyFileSync(s, d);
        }
      };
      fs.copyFileSync(r("src/manifest.json"), resolve(outDir, "manifest.json"));
      if (fs.existsSync(r("icons"))) copyDir(r("icons"), resolve(outDir, "icons"));
      if (fs.existsSync(r("vendor"))) copyDir(r("vendor"), resolve(outDir, "vendor"));

      // 扩展页面以 chrome-extension:// 同源加载，无需 crossorigin；剥离它以规避
      // 个别 Chrome 版本对模块脚本的同源 CORS 告警，并去掉无用的 modulepreload polyfill 链接。
      const stripHtml = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            stripHtml(p);
          } else if (entry.isFile() && entry.name.endsWith(".html")) {
            let html = fs.readFileSync(p, "utf8");
            html = html.replace(/\s+crossorigin/g, "");
            html = html.replace(/<link rel="modulepreload"[^>]*>\s*/g, "");
            fs.writeFileSync(p, html);
          }
        }
      };
      stripHtml(outDir);
    },
  };
}

// MV3 的 content script / 注入脚本以「经典脚本」方式加载，产物里不能出现
// import/export。但它们同样需要复用 src/lib 下的工具函数，若直接 import，
// Rollup 会把共享模块抽成独立 chunk，产物就带上 import 而违规。
//
// 解决办法：对标记为经典脚本的入口，在 transform 阶段把 `import ... from
// "./lib/*.js"` 就地展开成模块源码（剥离 export 关键字），让产物保持单文件
// 自包含。源码里照常写 import，单一来源不复制代码。
// 注意：Windows 下 resolve() 产出反斜杠，而 Rollup 传入的 id 用正斜杠，
// 统一成正斜杠后再比较，否则匹配不上（插件会静默失效，产物重新出现 import）。
const CLASSIC_LIB_ENTRIES = new Set([r("src/content.js").replace(/\\/g, "/")]);

// 经典脚本还可能需要 npm 包（目前是 turndown / turndown-plugin-gfm）。
// 这些包本身是 ESM，直接展开会与入口里的同名变量冲突，所以各自用 IIFE 包一层，
// 只把入口需要的名字暴露出来。这里指定「浏览器版 ESM 单文件」，它们不带任何
// import，展开起来最干净。
const NPM_INLINE_FILES = {
  turndown: "node_modules/turndown/lib/turndown.browser.es.js",
  "turndown-plugin-gfm": "node_modules/turndown-plugin-gfm/lib/turndown-plugin-gfm.es.js"
};

// 剥掉 export 语法，并记下模块对外暴露了哪些名字
function stripExports(rawCode) {
  let code = rawCode;
  let defaultName = null;
  const named = [];

  code = code.replace(/^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (_m, body) => {
    body.split(",").forEach((part) => {
      const as = part.trim().split(/\s+as\s+/);
      const local = as[0].trim();
      const exported = as.length > 1 ? as[1].trim() : local;
      if (!local) return;
      if (exported === "default") defaultName = local;
      else named.push(local);
    });
    return "";
  });

  const defaultMatch = code.match(/^export\s+default\s+([A-Za-z0-9_$]+)\s*;?[ \t]*$/m);
  if (defaultMatch) {
    defaultName = defaultMatch[1];
    code = code.replace(defaultMatch[0], "");
  }

  code = code.replace(/^export\s+(?=(?:function|const|let|var|class|async)\b)/gm, "");
  return { code, defaultName, named };
}

function inlineClassicLibs() {
  // 展开一个 npm 包：用 IIFE 包裹源码，返回包内部的导出名
  const inlineNpm = (pkg, state) => {
    const rel = NPM_INLINE_FILES[pkg];
    if (!rel) {
      return null;
    }
    if (!state.npm.has(pkg)) {
      const { code, defaultName, named } = stripExports(fs.readFileSync(r(rel), "utf8"));
      const returned = defaultName || `{ ${named.join(", ")} }`;
      const varName = `__inline_${pkg.replace(/[^a-z0-9]+/gi, "_")}`;
      state.npm.set(pkg, varName);
      state.prelude.push(
        `const ${varName} = (function () {\n"use strict";\n${code}\nreturn ${returned};\n})();\n`
      );
    }
    return state.npm.get(pkg);
  };

  // 递归展开一个本地模块：去掉 export，并递归处理它自己的 import
  const expand = (file, state) => {
    const key = resolve(file);
    if (state.files.has(key)) {
      return "";
    }
    state.files.add(key);
    let code = fs.readFileSync(key, "utf8");
    code = replaceImports(code, dirname(key), state, false);
    return stripExports(code).code;
  };

  // 把 import 语句替换成内联代码。
  //
  // 关键点：展开后的模块是「平铺」到同一作用域的，不再是独立模块作用域，所以
  // npm 包的 IIFE 结果必须显式绑定到 import 时的本地名，否则（a）该名字没有定义，
  // （b）IIFE 因无人引用会被 tree-shake 掉，其内部符号还会被重命名成 Xxx2。
  // 这里无论入口还是被展开的模块，都生成绑定；同一名字只生成一次。
  const replaceImports = (code, dir, state, isEntry) => {
    // 行尾统一成 LF 再匹配。
    //
    // 本仓库在 Windows 上 core.autocrlf=true，工作副本随时可能是 CRLF（git checkout
    // 就会转一次）。下面两个正则用 `[ \t]*\n` 收敛行尾，多出来的 `\r` 会让整条 import
    // 匹配不上 —— 入口文件里的 import 残留会被 Rollup 打成 chunk 引用，产物在经典脚本
    // 环境下直接报错，而报错指向 dist 产物，很难反查到这里；子模块里的残留更隐蔽，
    // 会把本该内联的 npm 包漏出去。统一在此归一化，入口与递归展开的模块都覆盖。
    if (code.includes("\r")) {
      code = code.replace(/\r\n/g, "\n");
    }
    // import { a, b } from "..."
    code = code.replace(
      /^\s*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*\n/gm,
      (match, names, spec) => {
        if (spec.startsWith(".")) {
          // 经典脚本入口（content.js）必须把所有相对 import 就地展开为源码，
          // 否则产物里残留的 ESM import 在经典脚本环境下直接报错。
          // 除了已内联的 lib，再放开 content 自有的 ./content/modules 子模块；
          // 其余相对 import 仍保留为 ESM，不改变既有行为。
          // content 自有子模块：原 layout 为 ./content/modules/*，重构后扁平化为
          // ./content/*。两者都需就地展开为经典脚本，不能保留 ESM import。
          const isContentLocal =
            spec.startsWith("./content/") || spec.includes("/content/modules/");
          if (isEntry && !spec.includes("/lib/") && !isContentLocal) return match;
          return expand(resolve(dir, spec), state);
        }
        const varName = inlineNpm(spec, state);
        if (!varName) return match;
        const alias = names.trim();
        if (state.bindings.has(alias)) return "";
        state.bindings.add(alias);
        return `const { ${alias} } = ${varName};\n`;
      }
    );
    // import X from "..."（默认导入）
    code = code.replace(
      /^\s*import\s+([A-Za-z0-9_$]+)\s+from\s*["']([^"']+)["'];?[ \t]*\n/gm,
      (match, alias, spec) => {
        if (spec.startsWith(".")) {
          return match;
        }
        const varName = inlineNpm(spec, state);
        if (!varName) return match;
        if (state.bindings.has(alias)) return "";
        state.bindings.add(alias);
        return `const ${alias} = ${varName};\n`;
      }
    );
    return code;
  };

  return {
    name: "inline-classic-libs",
    transform(code, id) {
      const normId = id.replace(/\\/g, "/").split("?")[0];
      if (!CLASSIC_LIB_ENTRIES.has(normId)) {
        return null;
      }
      const state = { files: new Set(), npm: new Map(), prelude: [], bindings: new Set() };
      let out = replaceImports(code, dirname(id), state, true);
      // IIFE 定义必须出现在引用之前，统一前置到文件开头
      if (state.prelude.length) {
        out = `${state.prelude.join("")}\n${out}`;
      }
      return out;
    }
  };
}

export default defineConfig({
  // 扩展以 chrome-extension:// 协议加载，所有资源用相对路径引用
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    // 扩展页面为现代 Chrome，原生支持 modulepreload，无需 Vite 注入 polyfill
    modulePreload: false,
    rollupOptions: {
      input: {
        // HTML 页面入口（侧边栏 / 渲染页）
        "src/sidepanel/sidepanel": r("src/sidepanel/sidepanel.html"),
        "src/render/md-render": r("src/render/md-render.html"),
        "src/render/pdf-render": r("src/render/pdf-render.html"),
        "src/render/word-render": r("src/render/word-render.html"),

        // JS 入口：后台 Service Worker、content script、运行时注入脚本
        "src/background/index": r("src/background/index.js"),
        "src/content": r("src/content.js"),
        "src/injected/feishu-shared": r("src/injected/feishu-shared.js"),
        "src/injected/extract-html": r("src/injected/extract-html.js"),
        "src/injected/extract-attachments": r("src/injected/extract-attachments.js"),
        "src/injected/count-images": r("src/injected/count-images.js")
      },
      output: {
        // 稳定、可预测的命名（不带哈希），确保 manifest 中的 service_worker /
        // content_scripts / web_accessible_resources 与 getURL 路径在构建后仍成立
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
        // 所有 src/lib/* 共享工具统一打成一个 lib.js 共享块，避免 Rollup 在
        // 「JS 入口(background) + HTML 入口(sidepanel)」共享同一模块时，把模块
        // 内联进 background 而遗漏 sidepanel 的导入（曾导致 sidepanel 运行时
        // 缺 sanitizeFilename）。单一共享块让每个入口都正确 import lib.js。
        manualChunks(id) {
          if (id.includes("/src/lib/")) return "lib";
        }
      }
    },
    // 注入脚本与 SW 经 executeScript / service_worker 以经典脚本方式加载，
    // 必须避免产物出现 import/export 语法，因此关闭代码分割、保持单文件无导出
    minify: false
  },
  plugins: [inlineClassicLibs(), copyExtensionAssets()]
});
