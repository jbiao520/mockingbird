import { indexProject, analyze } from '../server/analyzer';
const index=await indexProject('./examples/payment-service');
console.log(JSON.stringify({entries:index.project.entries,methods:index.methods.map(m=>[m.className,m.name]),flow:analyze(index,index.project.entries[0].id)},null,2));
