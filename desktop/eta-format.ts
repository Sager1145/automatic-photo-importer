/** How a time left is rounded for display, and how long a shown value is held before it changes. Pure: no clock, callers pass `now`.
 * The renderer's formatRemaining and the main process's DisplayHold share remainingBucket. See docs/eta-estimates.md. */

/** What a time left reads as: under a minute, minutes (exact to 10, then to 5), hours and minutes, or whole hours (from 10 h). */
export type RemainingBucket={unit:'under'}|{unit:'min';minutes:number}|{unit:'hm';hours:number;minutes:number}|{unit:'h';hours:number};

export function remainingBucket(seconds:number):RemainingBucket{
 if(!(seconds>=60))return {unit:'under'};
 const minutes=Math.round(seconds/60),rounded=minutes<=10?minutes:Math.round(minutes/5)*5;
 if(rounded<60)return {unit:'min',minutes:rounded};
 const hours=Math.floor(rounded/60),rest=rounded%60;
 return hours>=10?{unit:'h',hours:Math.round(rounded/60)}:rest?{unit:'hm',hours,minutes:rest}:{unit:'h',hours};
}
/** The bucket as a representative number of seconds, equal for every value that reads the same. */
export function bucketSeconds(seconds:number):number{
 const bucket=remainingBucket(seconds);
 return bucket.unit==='under'?0:bucket.unit==='min'?bucket.minutes*60:bucket.unit==='hm'?bucket.hours*3600+bucket.minutes*60:bucket.hours*3600;
}
/** The smallest time left that reads as the same bucket as `seconds`. */
export function bucketLowerEdge(seconds:number):number{
 const target=bucketSeconds(seconds);
 if(target===0)return 0;
 let low=0,high=Math.max(seconds,60);
 for(let i=0;i<48;i++){const middle=(low+high)/2;if(bucketSeconds(middle)===target)high=middle;else low=middle;}
 return high;
}

/** "about 2–4 h": shown while the estimate is still wide (high/low >= 1.6) and long enough to matter (>= 10 min).
 * Minutes round to 5 when the high end is under an hour, otherwise whole hours. */
export type RemainingRange={unit:'min';low:number;high:number}|{unit:'h';low:number;high:number};
export function remainingRange(eta:number,low:number,high:number):RemainingRange|undefined{
 if(!(eta>=600)||!(low>0)||!(high>low)||high/low<1.6)return undefined;
 if(high<3600){
  const lo=Math.max(5,Math.round(low/300)*5),hi=Math.max(lo+5,Math.round(high/300)*5);
  return {unit:'min',low:lo,high:hi};
 }
 const lo=Math.max(1,Math.round(low/3600)),hi=Math.max(lo+1,Math.round(high/3600));
 return {unit:'h',low:lo,high:hi};
}

/** Holds the shown time left steady: it changes at most every 5 s; down after 5 s below the shown bucket's lower edge (at once below half);
 * up only after 20 s at 1.15x and at least +60 s, and at most once a minute. One per job. */
export class DisplayHold{
 private shown?:number;private changed=-Infinity;private raised=-Infinity;private below?:number;private above?:number;
 /** The value to show for this raw time left (seconds), as the bucket's representative seconds; undefined while there is none. */
 next(raw:number|undefined,now:number):number|undefined{
  if(raw===undefined||!Number.isFinite(raw)){this.reset();return undefined;}
  raw=Math.max(0,raw);
  if(this.shown===undefined){this.shown=bucketSeconds(raw);this.changed=now;this.below=this.above=undefined;return this.shown;}
  const shown=this.shown,edge=bucketLowerEdge(shown);
  this.below=raw<edge?this.below??now:undefined;
  this.above=raw>=shown*1.15&&raw>=shown+60?this.above??now:undefined;
  const settled=now-this.changed>=5000;
  const set=(value:number,up=false)=>{const bucket=bucketSeconds(value);if(bucket!==shown){this.shown=bucket;this.changed=now;if(up)this.raised=now;}this.below=this.above=undefined;};
  if(raw<shown*0.5)set(raw);
  else if(settled&&this.below!==undefined&&now-this.below>=5000)set(raw);
  else if(settled&&this.above!==undefined&&now-this.above>=20000&&now-this.raised>=60000)set(raw,true);
  return this.shown;
 }
 reset(){this.shown=undefined;this.changed=-Infinity;this.below=this.above=undefined;}
 get value(){return this.shown;}
}
