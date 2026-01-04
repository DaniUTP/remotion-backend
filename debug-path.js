const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

const buildDir = path.join(__dirname, 'build');
const indexHtml = path.join(buildDir, 'index.html');
const serveUrl = pathToFileURL(buildDir).href;

console.log('__dirname:', __dirname);
console.log('Build Dir:', buildDir);
console.log('Index HTML Path:', indexHtml);
console.log('Exists?', fs.existsSync(indexHtml));
console.log('Serve URL:', serveUrl);
