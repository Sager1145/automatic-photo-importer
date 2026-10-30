import {message} from './messages';
import type {Job,NoMetadataHandling,Review} from './shared';

/** What an applied review runs as. An organize review always becomes an organization job (titlebar Stop
 * imports leaves it alone, Library › Organize shows it, Retry can plan it again) whether it was opened from
 * Organize or parked from a queued organization; `organization` is the run Retry and Skip plan again, already
 * confirmed. An import review stays an import job. */
export function appliedReviewJob<R extends {sourceFolders?:string[]}>(id:string,prepared:{review:Review;request:R;origin?:{jobId?:string;organization?:boolean;folders?:string[]};useFileDate?:boolean;handling?:Exclude<NoMetadataHandling,'fileDate'>}):{job:Job;organization?:R&{confirmed:true}}{
 const {review,request,origin}=prepared,organizing=review.kind==='reorganize';
 const folders=origin?.folders??(request.sourceFolders?.length?request.sourceFolders:undefined);
 const job:Job={id,source:review.source,phase:'verifying',detail:message('job.revalidating'),errors:[],backup:review.backup,unknownConfirmed:true,...(prepared.useFileDate?{useFileDate:true}:{}),...(prepared.handling?{noMetadataHandling:prepared.handling}:{}),...(organizing?{organization:true,...(folders?{folders}:{})}:{})};
 return organizing?{job,organization:{...request,confirmed:true}}:{job};
}
