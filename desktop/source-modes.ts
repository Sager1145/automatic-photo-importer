import type {Source} from './shared';
/** Publish an explicitly chosen import mode without changing device identity or selection.
 * Discovery may replace a chosen folder with its storage volume; its registration still owns
 * the mode. Unregistered storage/camera sources retain their existing meaning. */
export function publishSourceModes(sources:readonly Source[],registered:ReadonlyMap<string,{backup:boolean}>):Source[]{
 return sources.map(source=>{const mode=registered.get(source.id);return mode?{...source,backup:mode.backup}:source;});
}
