import { app, BrowserWindow, dialog, Menu } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from '../server/api';
let service:Awaited<ReturnType<typeof createServer>>|undefined;
const windows=new Map<string,BrowserWindow>();
let quitting=false,quitPending=false;
async function boot(){
  app.setName('Mockingbird');if(process.env.MOCKINGBIRD_DATA_DIR)app.setPath('userData',process.env.MOCKINGBIRD_DATA_DIR);
  if(!app.requestSingleInstanceLock()){app.quit();return;}
  app.on('second-instance',()=>{const window=BrowserWindow.getFocusedWindow()||windows.values().next().value;if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
  await app.whenReady();
  const root=app.getAppPath(),dataDir=process.env.MOCKINGBIRD_DATA_DIR||app.getPath('userData');
  const icon=path.join(root,'dist/renderer/icon.png');
  if(process.platform==='darwin')app.dock?.setIcon(icon);
  const sampleSource=app.isPackaged?path.join(process.resourcesPath,'examples/payment-service'):path.join(root,'examples/payment-service');
  const samplePath=path.join(dataDir,'examples/payment-service');
  try{await fs.access(samplePath);}catch{await fs.mkdir(path.dirname(samplePath),{recursive:true});await fs.cp(sampleSource,samplePath,{recursive:true,filter:s=>!s.includes('/target')&&!s.includes('/.mockingbird')});}
  const parent=(clientId?:string)=>clientId?windows.get(clientId):BrowserWindow.getFocusedWindow()||undefined;
  service=await createServer({root,dataDir,samplePath,desktop:true,runtimeDir:app.isPackaged?path.join(process.resourcesPath,'runtime'):path.join(root,'runtime'),chooseDirectory:async clientId=>{
    const owner=parent(clientId),options={title:'打开 Java 项目',properties:['openDirectory'] as ('openDirectory')[]};
    const result=await(owner?dialog.showOpenDialog(owner,options):dialog.showOpenDialog(options));return result.canceled?null:result.filePaths[0];
  },saveExport:async(artifact,clientId)=>{
    const owner=parent(clientId),options={title:'导出 Mock',defaultPath:artifact.filename,filters:[{name:'JSON',extensions:['json']}]};
    const result=await(owner?dialog.showSaveDialog(owner,options):dialog.showSaveDialog(options));
    if(result.canceled||!result.filePath)return null;await fs.writeFile(result.filePath,artifact.content,'utf8');return result.filePath;
  },focusWindow:async clientId=>{
    const window=windows.get(clientId);if(!window||window.isDestroyed())return false;
    if(window.isMinimized())window.restore();window.show();window.focus();return true;
  },openProjectWindow:async(projectId,clientId)=>{openWindow(projectId,clientId);}},0);
  const url=`http://127.0.0.1:${service.port}`;
  async function flush(window:BrowserWindow){
    if(window.isDestroyed()||window.webContents.isDestroyed())return;
    await window.webContents.executeJavaScript('window.mockingbirdFlush ? window.mockingbirdFlush() : Promise.resolve()');
  }
  function openWindow(projectId?:string,clientId:string=randomUUID()){
    const window=new BrowserWindow({width:1500,height:980,minWidth:1060,minHeight:720,title:'Mockingbird',icon,backgroundColor:'#f7f9fc',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    windows.set(clientId,window);let closing=false,allowClose=false;
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,destination)=>{if(new URL(destination).origin!==url)event.preventDefault();});
    const destination=new URL(url);destination.searchParams.set('client',clientId);if(projectId)destination.searchParams.set('project',projectId);
    void window.loadURL(destination.toString());
    window.on('close',event=>{
      if(allowClose)return;event.preventDefault();if(closing||quitting)return;closing=true;
      void(async()=>{try{await flush(window);await service!.projects.closeClient(clientId);allowClose=true;window.close();}catch(e){closing=false;dialog.showErrorBox('无法关闭项目',String(e));}})();
    });
    window.on('closed',()=>windows.delete(clientId));return window;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Mockingbird',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},
    {label:'文件',submenu:[{label:'打开项目…',accelerator:'CmdOrCtrl+O',click:()=>{void BrowserWindow.getFocusedWindow()?.webContents.executeJavaScript("window.dispatchEvent(new CustomEvent('mockingbird:open-project'))");}},{label:'新建窗口',accelerator:'CmdOrCtrl+Shift+N',click:()=>openWindow()},{role:'close'}]},
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'视图',submenu:[{role:'reload'},{role:'toggleDevTools'},{type:'separator'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
    {label:'窗口',submenu:[{role:'minimize'},{role:'front'}]}
  ]));
  openWindow();
  app.on('activate',()=>{if(!windows.size&&!quitting)openWindow();});
  app.on('window-all-closed',()=>{if(!quitting)app.quit();});
  app.on('before-quit',event=>{
    if(quitting)return;event.preventDefault();if(quitPending)return;quitPending=true;
    void(async()=>{
      try{await Promise.all([...windows.values()].map(flush));quitting=true;await service?.close();for(const window of windows.values())window.destroy();app.quit();}
      catch(e){quitting=false;quitPending=false;dialog.showErrorBox('无法退出 Mockingbird',String(e));}
    })();
  });
}
void boot().catch(error=>{dialog.showErrorBox('Mockingbird 启动失败',String(error));app.quit();});
