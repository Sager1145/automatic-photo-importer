/** A finished import (never an organization run, never a failed or stopped job) asks for the backup organization check that follows it. */
export const organizesAfterImport=(job:{phase:string},reorganizing:boolean)=>!reorganizing&&job.phase==='complete';
