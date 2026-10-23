/** Records v5 for this Mac's own caches in the app's data folder: the stored value is {v:5,kind,...}. A cache in any
 * other shape is not read; it is rebuilt as if there were none. */
export type CacheKind='listing'|'scan'|'imported'|'placement'|'eta';
/** The stored value in the shape its loader checks (with `version` set to the loader's number); undefined for anything else. */
export function readCache<T>(value:unknown,kind:CacheKind,version:number):T|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const record=value as Record<string,unknown>;
 if(record.v===5&&record.kind===kind){const {v:_v,kind:_kind,...rest}=record;return {...rest,version} as T;}
 return undefined;
}
/** The value as this version writes it. */
export function cacheRecord(kind:CacheKind,value:Record<string,unknown>):Record<string,unknown>{const {version:_version,...rest}=value;return {v:5,kind,...rest};}
