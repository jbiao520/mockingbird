import path from "node:path";
import os from "node:os";
import { createServer } from "./api";
export { createServer } from "./api";
async function start(){
 const service=await createServer({root:process.cwd(),dataDir:process.env.MOCKINGBIRD_DATA_DIR||path.join(os.homedir(),".mockingbird")},Number(process.env.PORT||4317));
 console.log(`Mockingbird ready at http://127.0.0.1:${service.port}`);
 let closing=false;for(const sig of ["SIGINT","SIGTERM"] as const)process.on(sig,()=>{if(closing)return;closing=true;void service.close().then(()=>process.exit(0));});
}
void start().catch(e=>{console.error(e);process.exit(1);});
