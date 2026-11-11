import {Folder} from 'lucide-react';
import {Icon} from '../ui';
import {useTranslation} from '../i18n';
import {queryFor,type BrowserState} from './state';
import {usePaged} from './use-paged';
import {VirtualList} from './VirtualList';
import {ColumnError} from './FacetColumn';
import type {BrowserAPI} from './api';
/** One level of the real folders: a single choice that opens the folder in the next column (no checkboxes). */
export function DirectoryColumn({depth,state,revision,api,onSelect}:{depth:number;state:BrowserState;revision:number;api:BrowserAPI;onSelect:(path:string)=>void}){
 const {t}=useTranslation();const parentPath=depth===0?'':state.folders[depth-1]!;const query={...queryFor(state),parentPath};const data=usePaged(JSON.stringify(query),revision,cursor=>api.catalogDirectories({...query,cursor}),!!state.libraryId);return <section className="browser-column" data-column-index={depth} data-testid="directory-column"><header><h3><Icon icon={Folder} size={16}/>{parentPath.split('/').at(-1)||t('Real folders')}</h3></header><ColumnError error={data.error} onRetry={data.reload}/><VirtualList label={`${t('Real folders')} ${depth+1}: ${parentPath||'/'}`} rows={data.rows.map(r=>({key:r.relativePath,label:r.name,count:r.count}))} emptyText={t('No subfolders')} checkable={false} picked={state.folders[depth]} onPick={row=>onSelect(row.key)} loading={data.loading} hasMore={data.hasMore} onMore={data.more}/></section>;
}
