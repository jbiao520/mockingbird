import { app, BrowserWindow, dialog, Menu } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from '../server/api';
let service:Awaited<ReturnType<typeof createServer>>|undefined;
let mainWindow:BrowserWindow|undefined;
let quitting=false;
async function boot(){
app.setName('Mockingbird');
await app.whenReady();
const root=app.getAppPath(),dataDir=app.getPath('userData');
const sampleSource=app.isPackaged?path.join(process.resourcesPath,'examples/payment-service'):path.join(root,'examples/payment-service');
const samplePath=path.join(dataDir,'examples/payment-service');
try{await fs.access(samplePath);}catch{await fs.mkdir(path.dirname(samplePath),{recursive:true});await fs.cp(sampleSource,samplePath,{recursive:true,filter:s=>!s.includes('/target')&&!s.includes('/.mockingbird')});}
service=await createServer({root,dataDir,samplePath,desktop:true,runtimeDir:app.isPackaged?path.join(process.resourcesPath,'runtime'):path.join(root,'runtime'),chooseDirectory:async()=>{
  const result=await dialog.showOpenDialog({title:'打开 Java 项目',properties:['openDirectory']});return result.canceled?null:result.filePaths[0];
},saveExport:async artifact=>{
  const result=await dialog.showSaveDialog({title:'导出 Mock',defaultPath:artifact.filename,filters:[{name:'JSON',extensions:['json']}]});
  if(result.canceled||!result.filePath)return null;
  await fs.writeFile(result.filePath,artifact.content,'utf8');return result.filePath;
}},0);
const url=`http://127.0.0.1:${service.port}`;
function openWindow(){
  mainWindow=new BrowserWindow({width:1500,height:980,minWidth:1060,minHeight:720,title:'Mockingbird',backgroundColor:'#f7f9fc',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(event,destination)=>{if(!destination.startsWith(url+'/'))event.preventDefault();});
  void mainWindow.loadURL(url);
}
Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Mockingbird',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'视图',submenu:[{role:'reload'},{role:'toggleDevTools'},{type:'separator'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
openWindow();
app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)openWindow();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;void service?.close().finally(()=>app.quit());});

}
void boot().catch(error=>{dialog.showErrorBox("Mockingbird 启动失败",String(error));app.quit();});
