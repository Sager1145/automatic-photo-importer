import {rolldown} from 'rolldown';

// Use the same native bundler as the renderer for all Electron entry points.
for (const [name,input] of [['main','desktop/main.ts'],['preload','desktop/preload.ts'],['scan-worker','desktop/scan-worker.ts'],['catalog-worker','desktop/catalog/worker.ts']]) {
 const bundle=await rolldown({input,platform:'node',external:['electron',/^exiftool-vendored(?:\/|$)/]});
 try {await bundle.write({file:`dist/desktop/${name}.cjs`,format:'cjs'});}
 finally {await bundle.close();}
}
