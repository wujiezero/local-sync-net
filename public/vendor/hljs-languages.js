import hljs from "./hljs-core.js";
import json from "./languages/json.js";
import yaml from "./languages/yaml.js";
import xml from "./languages/xml.js";
import javascript from "./languages/javascript.js";
import typescript from "./languages/typescript.js";
import python from "./languages/python.js";
import bash from "./languages/bash.js";
import sql from "./languages/sql.js";
import css from "./languages/css.js";
import markdown from "./languages/markdown.js";
import ini from "./languages/ini.js";
import dockerfile from "./languages/dockerfile.js";
import go from "./languages/go.js";
import rust from "./languages/rust.js";
import php from "./languages/php.js";
import ruby from "./languages/ruby.js";
import nginx from "./languages/nginx.js";
import http from "./languages/http.js";
import csharp from "./languages/csharp.js";
import cpp from "./languages/cpp.js";
import c from "./languages/c.js";
import plaintext from "./languages/plaintext.js";

const pack = [
  ["json", json],
  ["yaml", yaml],
  ["xml", xml],
  ["javascript", javascript],
  ["typescript", typescript],
  ["python", python],
  ["bash", bash],
  ["sql", sql],
  ["css", css],
  ["markdown", markdown],
  ["ini", ini],
  ["dockerfile", dockerfile],
  ["go", go],
  ["rust", rust],
  ["php", php],
  ["ruby", ruby],
  ["nginx", nginx],
  ["http", http],
  ["csharp", csharp],
  ["cpp", cpp],
  ["c", c],
  ["plaintext", plaintext],
];

for (const [name, def] of pack) hljs.registerLanguage(name, def);

hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("node", javascript);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("zsh", bash);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("svg", xml);
hljs.registerLanguage("cs", csharp);
hljs.registerLanguage("c++", cpp);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rb", ruby);
hljs.registerLanguage("golang", go);
hljs.registerLanguage("text", plaintext);

export default hljs;
