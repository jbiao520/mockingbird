import { app, BrowserWindow } from 'electron';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Bird } from 'lucide-react';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Use the same Lucide Bird and colors as the title bar.
const bird = renderToStaticMarkup(createElement(Bird, {
  x: 192, y: 192, size: 640, color: '#90b9ee',
}));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="64" y="64" width="896" height="896" rx="200" fill="#182335"/>${bird}</svg>`;
const root = fileURLToPath(new URL('../', import.meta.url));
async function generate() {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await window.loadURL('data:text/html,<html></html>');
    const png = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1024;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    await mkdir(path.join(root, 'public'), { recursive: true });
    await writeFile(path.join(root, 'public/icon.svg'), svg + '\n');
    await writeFile(path.join(root, 'public/icon.png'), Buffer.from(png, 'base64'));
    console.log('Generated public/icon.svg and public/icon.png from the title-bar Bird.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.quit();
  }
}

// Let Electron finish loading the entry module before waiting for readiness.
void generate();
