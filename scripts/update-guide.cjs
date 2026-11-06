// Regenerate the in-app copy button after editing GoogleAppsScript_Code.gs.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const file = path.join(root, 'index.html');
const backend = fs.readFileSync(path.join(root, 'GoogleAppsScript_Code.gs'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(file, 'utf8');
const start = html.indexOf('    const APPS_SCRIPT_SOURCE =');
const end = html.indexOf('    function copyAppsScriptCode()', start);
if (start < 0 || end < 0) throw new Error('Apps Script guide markers missing');
const replacement = '    const APPS_SCRIPT_SOURCE = ' + JSON.stringify(backend).replace(/</g, '\\u003c') + ';\n\n' +
  '    function populateAppsScriptCodeBlock() {\n' +
  '      const textarea = document.getElementById("appsScriptCodeBlock");\n' +
  '      if (textarea) textarea.value = APPS_SCRIPT_SOURCE;\n' +
  '    }\n\n';
fs.writeFileSync(file, html.slice(0, start) + replacement + html.slice(end));
