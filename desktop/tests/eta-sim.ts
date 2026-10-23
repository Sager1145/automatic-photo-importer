/** A simulated transfer for the time-left model: files of given sizes take a + b*size seconds each, on a simulated clock. */
import {StepFit,type Coef} from '../eta-model';

export function lcg(seed:number){let s=seed;return()=>(s=(s*1103515245+12345)%2147483648)/2147483648;}
export interface Point {t:number;est:number;truth:number;theta:Coef;windows:number;observed:number;files:number;u:number;/** What the prior alone would say. */priorEst:number;}
export interface SimOptions {sizes:number[];a:number;b:number;prior:Coef;T0?:number;noise?:number;seed?:number;drop?:{at:number;factor:number};stalls?:{at:number;length:number}[];gaps?:{at:number;length:number}[];every?:number;fit?:StepFit;start?:number;}
/** Sizes are gigabytes. Samples the model once a second (or `every`). */
export function simulate(o:SimOptions){
 const rnd=lcg(o.seed??7),fit=o.fit??new StepFit(o.prior,o.T0??20),n=o.sizes.length,totalGB=o.sizes.reduce((x,y)=>x+y,0);
 const durations=o.sizes.map(size=>o.a+o.b*size),trace:Point[]=[];
 let t=o.start??0,files=0,gb=0,partial=0,left=durations[0]??0,index=0,next=t;
 const tick=0.25,every=o.every??1;
 while(index<n){
  let speed=1+(o.noise??0)*(rnd()*2-1);
  if(o.drop&&t>=o.drop.at)speed/=o.drop.factor;
  const stalled=(o.stalls??[]).some(stall=>t>=stall.at&&t<stall.at+stall.length);
  let budget=stalled?0:tick*speed;
  while(budget>0&&index<n){
   const use=Math.min(budget,left);left-=use;budget-=use;partial+=use/durations[index]!*o.sizes[index]!;
   if(left<=1e-12){gb+=o.sizes[index]!;partial=0;files++;index++;left=durations[index]??0;}
  }
  t+=tick;
  const gap=(o.gaps??[]).find(item=>Math.abs(t-item.at)<tick/2);
  if(gap)t+=gap.length;
  if(t>=next){
   next=t+every;
   fit.observe(t*1000,files,(gb+partial)*1e9);
   const est=fit.remaining(n-files,Math.max(0,totalGB-gb-partial)*1e9);
   let truth=durations.slice(index).reduce((x,y)=>x+y,0)-(durations[index]!==undefined?durations[index]!-left:0);
   const factor=o.drop&&t>=o.drop.at?o.drop.factor:1;
   if(o.drop&&t<o.drop.at){const until=o.drop.at-t;truth=truth<=until?truth:until+(truth-until)*o.drop.factor;}else truth*=factor;
   trace.push({t,est,truth,theta:fit.theta(),windows:fit.windows,observed:fit.observed,files,u:fit.uncertainty('default'),priorEst:o.prior.a*(n-files)+o.prior.b*Math.max(0,totalGB-gb-partial)});
  }
 }
 return {trace,fit,total:durations.reduce((x,y)=>x+y,0),files:n,totalGB};
}
export const ratio=(point:Point)=>point.est/point.truth;
export const within=(point:Point,tolerance:number)=>Math.abs(ratio(point)-1)<=tolerance;
export const mixedSizes=(count:number,seed=3)=>{const rnd=lcg(seed);return Array.from({length:count},()=>{const r=rnd();return r<.6?0.025:r<.95?0.005:0.5;});};
