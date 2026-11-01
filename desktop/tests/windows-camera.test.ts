import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { windowsCameraBridgeArgs } from '../platform/windows-camera';

// The bridge's C# (IFileOperation and the WPD stream reader) is compiled when the script starts, so a mistake in it
// only shows on Windows: the script must start and answer "list" (an empty list without a camera) and unknown commands.
test('the Windows camera bridge compiles and answers list over its JSONL protocol', {skip:process.platform!=='win32'&&'PowerShell and Windows Portable Devices are Windows only',timeout:120000}, async () => {
  const child=spawn('powershell.exe',windowsCameraBridgeArgs(),{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stderr='';child.stderr.on('data',(text:Buffer)=>{stderr+=text.toString();});
  try {
    const replies=new Map<string,any>();let buffer='';
    const reply=(id:string)=>new Promise<any>((resolve,reject)=>{
      const check=()=>{if(replies.has(id)){child.stdout.off('data',check);resolve(replies.get(id));}};
      child.stdout.on('data',check);child.once('exit',()=>reject(new Error(`The bridge exited: ${stderr}`)));check();
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(text:string)=>{buffer+=text;let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);try{const message=JSON.parse(line);if(!message.progress)replies.set(message.id,message);}catch{}}});
    child.stdin.write(`${JSON.stringify({command:'list',id:'list'})}\n${JSON.stringify({command:'format',id:'other'})}\n`);
    const listed=await reply('list');
    assert.equal(listed.error,undefined,stderr);assert.ok(Array.isArray(listed.result));
    for(const camera of listed.result){assert.equal(typeof camera.name,'string');assert.equal(typeof camera.cameraID,'string');}
    assert.equal((await reply('other')).error,'Unknown native camera command.');
    // PowerShell reports progress as CLIXML on stderr; only an error record there means something failed.
    assert.doesNotMatch(stderr,/<S S="Error">/);
  } finally { child.kill(); }
});
