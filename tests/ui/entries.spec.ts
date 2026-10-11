import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../../server/api';

const visible=(page:Page)=>page.locator('.project-container:not([hidden])');
const legacyFile='src/main/java/dev/mockingbird/payment/LegacyOrderController.java';
const legacySource=`package dev.mockingbird.payment;

public class LegacyOrderController {
    @GetMapping("/legacy/orders")
    public String listOrders() {
        return "ok";
    }
}
`;

test('Entry discovery selects an available OpenCode model when it is the only CLI',async({page})=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-opencode-model-'));
  const root=path.join(temp,'payment');
  await fs.cp('examples/payment-service',root,{recursive:true,filter:source=>!source.includes(`${path.sep}target`)&&!source.includes(`${path.sep}.mockingbird`)});
  const executable=path.join(temp,'fake-opencode.cjs');
  await fs.writeFile(executable,`#!/usr/bin/env node
if(process.argv.includes('models')){
  console.log('opencode/usable-model');
  console.log(JSON.stringify({name:'Usable Model',variants:{medium:{}}}));
  console.log('opencode/fast-model');
  console.log(JSON.stringify({name:'Fast Model'}));
  process.exit(0);
}
process.exit(0);
`,{mode:0o755});
  const service=await createServer({root:process.cwd(),dataDir:path.join(temp,'data')},0);
  service.projects.agents=[{id:'codex',installed:false},{id:'opencode',installed:true,path:executable},{id:'grok',installed:false}];
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(`http://127.0.0.1:${service.port}`);
    await page.getByRole('button',{name:'打开新项目',exact:true}).click();
    await visible(page).getByPlaceholder('/path/to/your/java-project').fill(root);
    await visible(page).getByRole('button',{name:'打开并索引',exact:true}).click();
    await expect(visible(page).locator('.project-root')).toContainText('payment');
    await visible(page).getByRole('button',{name:'AI 发现入口',exact:true}).first().click();
    const dialog=page.getByRole('dialog',{name:'AI 发现入口'});
    await expect(dialog.getByLabel('发现入口 Agent')).toHaveValue('opencode');
    const models=dialog.getByLabel('发现入口模型',{exact:true});
    await expect(models).toHaveValue('opencode/usable-model');
    await expect(models.locator('option:checked')).toHaveText('Usable Model · 默认');
    await expect(models.locator('option[value="opencode/fast-model"]')).toHaveText('Fast Model · 已禁用');
    await expect(dialog.getByRole('button',{name:'开始扫描'})).toBeEnabled();
    expect(errors).toEqual([]);
  }finally{await service.close();await fs.rm(temp,{recursive:true,force:true});}
});

test('Confirmed AI entry discovery adds a project entry and opens a Flow',async({page})=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-entry-ui-'));
  const root=path.join(temp,'legacy-service');
  await fs.cp('examples/payment-service',root,{recursive:true,filter:source=>!source.includes(`${path.sep}target`)&&!source.includes(`${path.sep}.mockingbird`)});
  const controller=path.join(root,'src/main/java/dev/mockingbird/payment/PaymentController.java');
  const java=await fs.readFile(controller,'utf8');
  await fs.writeFile(controller,java.replace('@RestController\n','').replace('@RequestMapping("/api/payment")\n',''));
  await fs.writeFile(path.join(root,legacyFile),legacySource);
  const executable=path.join(temp,'fake-codex.cjs');
  await fs.writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='app-server'){
  let buffer='';
  process.stdin.on('data',chunk=>{
    buffer+=chunk;
    const lines=buffer.split('\\n');
    buffer=lines.pop()||'';
    for(const line of lines){
      if(!line.trim())continue;
      const message=JSON.parse(line);
      if(message.id===1)process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
      if(message.id===2)process.stdout.write(JSON.stringify({id:2,result:{data:[{model:'gpt-test',displayName:'GPT Test',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}]}})+'\\n');
    }
  });
  setInterval(()=>{},1000);
}else{
  if(args[0]!=='exec')throw new Error('unexpected command');
  if(args[args.indexOf('--sandbox')+1]!=='read-only')throw new Error('missing read-only sandbox');
  const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
  if(!schema.properties||!schema.properties.entries)throw new Error('entry schema missing');
  const file='${legacyFile}';
  const source=fs.readFileSync('project/'+file,'utf8');
  const line=source.split('\\n').findIndex(row=>row.includes('@GetMapping'))+1;
  if(line<1||!source.includes('listOrders'))throw new Error('legacy controller missing from snapshot');
  const result={summary:'找到未标注的订单入口',entries:[{method:'GET',path:'/legacy/orders',className:'LegacyOrderController',name:'listOrders',file,line,note:'类上没有 Controller 注解'}]};
  let input='';
  process.stdin.on('data',chunk=>{input+=chunk;});
  process.stdin.on('end',()=>{
    if(!input.includes('继承'))throw new Error('user prompt missing');
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
  });
}
`,{mode:0o755});
  const service=await createServer({root:process.cwd(),dataDir:path.join(temp,'data')},0);
  service.projects.agents=[{id:'codex',installed:true,path:executable},{id:'opencode',installed:false},{id:'grok',installed:false}];
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(`http://127.0.0.1:${service.port}`);
    await page.getByRole('button',{name:'打开新项目',exact:true}).click();
    await visible(page).getByPlaceholder('/path/to/your/java-project').fill(root);
    await visible(page).getByRole('button',{name:'打开并索引',exact:true}).click();
    await expect(visible(page).locator('.project-root')).toContainText('legacy-service');
    await expect(visible(page).locator('.api-empty')).toContainText('静态索引没有发现 Spring MVC 入口');
    await expect(visible(page).locator('.explorer-empty').filter({hasText:'用 AI 发现入口'})).toHaveText('用 AI 发现入口');
    await visible(page).locator('.api-empty').getByRole('button',{name:'AI 发现入口',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'AI 发现入口'});
    await expect(dialog.getByRole('button',{name:'开始扫描'})).toBeEnabled();
    await dialog.getByRole('button',{name:'开始扫描'}).click();
    const choice=dialog.getByRole('checkbox',{name:'选择 LegacyOrderController.listOrders'});
    await expect(choice).toBeVisible();
    await choice.check();
    await dialog.getByLabel('listOrders 的路径').fill('/manual/orders');
    await dialog.getByRole('button',{name:'提交所选入口'}).click();
    await expect(page.getByRole('status')).toContainText('已加入 1 个入口');
    const card=visible(page).locator('.api-card',{hasText:'/manual/orders'});
    await expect(card).toContainText('手动确认');
    await expect(visible(page).locator('.entry-row',{hasText:'/manual/orders'})).toBeVisible();
    await card.click();
    await expect(visible(page).locator('.flow-workspace')).toBeVisible();
    await expect(visible(page).getByRole('button',{name:'手动添加依赖'})).toBeVisible();
    expect(errors).toEqual([]);
  }finally{await service.close();await fs.rm(temp,{recursive:true,force:true});}
});
