// 顺序执行真实临时库和离线桥接测试，任何子进程失败都传播退出码。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const files=readdirSync(path.join(root,'scripts')).filter(name=>/^test-memory-.+\.mjs$/.test(name)).sort();
let passed=0;
for(const file of files){const result=spawnSync(process.execPath,[path.join(root,'scripts',file)],{cwd:root,stdio:'inherit',env:process.env});if(result.status!==0)process.exit(result.status||1);passed++;}
console.log(`Memory suite: ${passed}/${files.length} passed.`);
