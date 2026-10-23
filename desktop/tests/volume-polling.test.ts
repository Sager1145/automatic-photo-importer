import test from 'node:test';
import assert from 'node:assert/strict';
import {describeChanged,physicalStores,type MountedVolume} from '../platform/volumes';

const volume=(path:string,free:number):MountedVolume=>({path,volumeId:path,free});

test('diskutil is asked only for mounts that are new or changed; free space is read afresh',async()=>{
 const memory=new Map<string,{fingerprint:string;volume:MountedVolume}>([['/Volumes/A',{fingerprint:'a1',volume:volume('/Volumes/A',100)}],['/Volumes/B',{fingerprint:'b1',volume:volume('/Volumes/B',200)}]]);
 const asked:string[]=[];
 const describe=async(mount:string)=>{asked.push(mount);return volume(mount,1);};
 const results=await describeChanged(['/Volumes/A','/Volumes/B','/Volumes/C'],['a1','b2','c1'],describe,async mount=>mount==='/Volumes/A'?42:undefined,memory);
 assert.deepEqual(asked,['/Volumes/B','/Volumes/C']);
 assert.deepEqual(results.map(item=>item.status==='fulfilled'?item.value.free:'x'),[42,1,1]);
});

test('a mount with no fingerprint is always described, and a failure is reported',async()=>{
 const memory=new Map([['/Volumes/A',{fingerprint:'a1',volume:volume('/Volumes/A',100)}]]);
 const asked:string[]=[];
 const results=await describeChanged(['/Volumes/A'],[undefined],async mount=>{asked.push(mount);throw new Error('timeout');},async()=>1,memory);
 assert.deepEqual(asked,['/Volumes/A']);assert.equal(results[0]!.status,'rejected');
});

test('the APFS list is read again only when the set of mounts changes',async()=>{
 let lists=0;const list=async()=>{lists++;return new Map([['disk3',String(lists)]]);};
 const first=await physicalStores(['/a','/b'],['1','2'],list);
 assert.equal((await physicalStores(['/b','/a'],['2','1'],list)).get('disk3'),first.get('disk3'));
 assert.equal(lists,1);
 await physicalStores(['/a','/b'],['1','3'],list);assert.equal(lists,2);
 await physicalStores(['/a'],['1'],list);assert.equal(lists,3);
});
