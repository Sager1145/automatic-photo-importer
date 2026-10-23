/** Seconds of history a rate is measured over, and the least history it needs before it is shown. */
const RATE_WINDOW=5000,RATE_MIN_SPAN=2000;
/** Bytes (or files) per second from successive totals: the change over the last 5 s, found by interpolating the running total at the
 * window's start, so every moment in it counts for its length and a burst or a pause of one file moves it little. Undefined until
 * 2 s of history; a stall reads 0 once the window holds nothing but the stall; a total that goes down starts a new measure. */
export class RateMeter {
 private samples:{at:number;value:number}[]=[];
 next(value:number,now:number):number|undefined{
  const samples=this.samples,last=samples[samples.length-1];
  if(last&&(value<last.value||now<last.at)){samples.length=0;}
  const latest=samples[samples.length-1];
  if(latest&&now===latest.at)latest.value=value;else samples.push({at:now,value});
  while(samples.length>2&&samples[1]!.at<=now-RATE_WINDOW)samples.shift();
  if(samples.length<2)return undefined;
  const first=samples[0]!;
  let base=first.value,from=first.at;
  if(first.at<now-RATE_WINDOW){const second=samples[1]!,share=(now-RATE_WINDOW-first.at)/(second.at-first.at);base=first.value+share*(second.value-first.value);from=now-RATE_WINDOW;}
  const span=now-from;
  return span>=RATE_MIN_SPAN?(value-base)/(span/1000):undefined;
 }
}
