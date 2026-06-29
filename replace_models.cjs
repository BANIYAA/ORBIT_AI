const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');
content = content.replace(/"gemini-2\.0-flash-lite-001"/g, '"gemini-1.5-flash"');
fs.writeFileSync('server.ts', content);
console.log('Replaced successfully');
