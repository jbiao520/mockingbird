import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../../server/api';

const visible=(page:Page)=>page.locator('.project-container:not([hidden])');

test('IME Enter confirms Chinese text without sending the AI prompt',async({page})=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-ime-'));
  const root=path.join(temp,'service');
  await fs.cp('examples/payment-service',root,{recursive:true,filter:source=>!source.includes('/target')&&!source.includes('/.mockingbird')});
  const service=await createServer({root:process.cwd(),dataDir:path.join(temp,'data')},0);
  page.on('pageerror',error=>{throw error;});
  try{
    await page.goto(`http://127.0.0.1:${service.port}`);
    await page.getByRole('button',{name:'打开新项目',exact:true}).click();
    await visible(page).getByPlaceholder('/path/to/your/java-project').fill(root);
    await visible(page).getByRole('button',{name:'打开并索引',exact:true}).click();
    await expect(visible(page).locator('.project-root')).toContainText('service');
    await expect(visible(page).locator('.busy-status')).toHaveCount(0);
    const prompt=visible(page).getByLabel('AI prompt',{exact:true});
    await prompt.fill('查询订单');
    await prompt.evaluate(element=>{
      const textarea=element as HTMLTextAreaElement;
      const key=(keyCode:number,isComposing:boolean)=>{
        const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing});
        Object.defineProperty(event,'keyCode',{get:()=>keyCode});
        Object.defineProperty(event,'which',{get:()=>keyCode});
        textarea.dispatchEvent(event);
      };
      textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      key(229,true);
      textarea.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'查询订单'}));
      key(229,false);
      key(13,false);
    });
    await page.waitForTimeout(300);
    await expect(prompt).toHaveValue('查询订单');
    await expect(visible(page).locator('.chat-message.user')).toHaveCount(0);
    await prompt.press('Shift+Enter');
    await expect(prompt).toHaveValue('查询订单\n');
    await expect(visible(page).locator('.chat-message.user')).toHaveCount(0);
    await prompt.press('Enter');
    await expect(visible(page).locator('.chat-message.user')).toContainText('查询订单');
    await expect(prompt).toHaveValue('');
  }finally{await service.close();await fs.rm(temp,{recursive:true,force:true});}
});
