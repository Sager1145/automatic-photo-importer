import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';

/** SHA-256 of a stream of chunks, computed off the main thread when it can be. */
export interface Hasher {
  /** Queue a chunk; resolves once few enough are pending, so memory stays bounded. The chunk is copied. */
  update(chunk:Buffer):Promise<void>;
  digest():Promise<string>;
  /** Forget an unfinished hash. */
  drop():void;
}
// Several hashes per worker: each id keeps its own state, and messages to one worker stay in order.
const SOURCE=`const {parentPort}=require('node:worker_threads');const {createHash}=require('node:crypto');const hashes=new Map();
parentPort.on('message',message=>{
 if(message.chunk){let hash=hashes.get(message.id);if(!hash){hash=createHash('sha256');hashes.set(message.id,hash);}hash.update(new Uint8Array(message.chunk));parentPort.postMessage({id:message.id,ack:true});}
 else if(message.final){const hash=hashes.get(message.id)??createHash('sha256');hashes.delete(message.id);parentPort.postMessage({id:message.id,hex:hash.digest('hex')});}
 else if(message.drop)hashes.delete(message.id);
});`;
/** Chunks queued per hash before update waits. */
const PENDING=4;
interface Waiting {acked:()=>void;done?:(hex:string)=>void;fail:(error:Error)=>void;}
/** Each message posted expects one reply: a worker stays referenced while any are due. */
function expect(slot:{worker:Worker;busy:number}):void {if(slot.busy++===0)slot.worker.ref();}
function settle(slot:{worker:Worker;busy:number}):void {if(slot.busy>0&&--slot.busy===0)slot.worker.unref();}
class Pool {
  private workers:{worker:Worker;waiting:Map<number,Waiting>;busy:number}[]=[];
  private next=0;private id=0;private failed=false;
  constructor(private readonly size:number) {}
  private worker() {
    if(this.failed) return undefined;
    if(this.workers.length<this.size) try {
      const worker=new Worker(SOURCE,{eval:true}),waiting=new Map<number,Waiting>(),slot={worker,waiting,busy:0};
      worker.on('message',(message:{id:number;ack?:boolean;hex?:string})=>{settle(slot);const item=waiting.get(message.id);if(!item)return;if(message.ack)item.acked();else if(message.hex!==undefined){waiting.delete(message.id);item.done?.(message.hex);}});
      // A worker that dies fails its hashes (the copy reports an error and can be retried);
      // later hashes run on the main thread.
      const broken=(error:Error)=>{this.failed=true;slot.busy=0;for(const item of waiting.values())item.fail(error);waiting.clear();};
      worker.on('error',broken);worker.on('exit',code=>broken(new Error(`Hashing worker stopped (${code})`)));
      // An idle worker never keeps the app (or a test run) alive; one with replies due does.
      worker.unref();
      this.workers.push(slot);
    } catch { this.failed=true; return undefined; }
    return this.workers[this.next++%this.workers.length];
  }
  hasher():Hasher {
    const slot=this.worker();
    // Without workers (or after one failed) hashing runs here, as it always used to.
    if(!slot) {const hash=createHash('sha256');return {update:async chunk=>{hash.update(chunk);},digest:async()=>hash.digest('hex'),drop:()=>{}};}
    const id=++this.id;let pending=0,wake:(()=>void)|undefined,finished=false,failure:Error|undefined,reject:((error:Error)=>void)|undefined;
    const item:Waiting={acked:()=>{pending--;wake?.();wake=undefined;},fail:error=>{failure=error;wake?.();wake=undefined;reject?.(error);}};slot.waiting.set(id,item);
    return {
      update:async chunk=>{
        if(failure) throw failure;
        const copy=new Uint8Array(chunk.byteLength);copy.set(chunk);
        pending++;expect(slot);slot.worker.postMessage({id,chunk:copy.buffer},[copy.buffer]);
        while(pending>=PENDING&&!failure) await new Promise<void>(resolve=>{wake=resolve;});
        if(failure) throw failure;
      },
      digest:()=>new Promise<string>((resolve,fail)=>{if(failure){fail(failure);return;}finished=true;item.done=resolve;reject=fail;expect(slot);slot.worker.postMessage({id,final:true});}),
      drop:()=>{if(!finished){finished=true;slot.waiting.delete(id);slot.worker.postMessage({id,drop:true});}},
    };
  }
}
const pool=new Pool(Math.max(1,Math.min(4,Math.floor(availableParallelism()/2))));
export const hasher=():Hasher=>pool.hasher();
