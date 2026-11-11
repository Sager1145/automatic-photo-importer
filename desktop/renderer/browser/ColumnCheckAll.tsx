import {useTranslation} from '../i18n';
/** A column header's checkbox: unchecked, it checks every row; checked or half set (some rows checked), it clears the
 * column's checks and its clicked row. Its name says which it does, and of which column (`name`). */
export function ColumnCheckAll({state,name,disabled=false,title,onChange}:{state:'none'|'some'|'all';/** The column, for the accessible name ("Select all: Camera"). */name?:string;disabled?:boolean;title?:string;onChange:(select:boolean)=>void}){
 const {t}=useTranslation();const select=state==='none';
 return <label className="browser-column-check" title={title??t(select?'Select all':'Deselect all')} data-disabled={disabled?'true':undefined}><input type="checkbox" data-testid="column-check-all" aria-label={name?t(select?'Select all: {name}':'Deselect all: {name}',{name}):t(select?'Select all':'Deselect all')} checked={state==='all'} disabled={disabled} ref={node=>{if(node)node.indeterminate=state==='some';}} onChange={()=>onChange(select)}/></label>;
}
