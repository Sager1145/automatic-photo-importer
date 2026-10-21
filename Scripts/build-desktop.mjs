import {rolldown} from 'rolldown';

// Use the same native bundler as the renderer for all Electron entry points.
for (const name of ['main','preload','scan-worker']) {
 const bundle=await rolldown({input:`desktop/${name}.ts`,platform:'node',external:['electron','exiftool-vendored']});
 try {await bundle.write({file:`dist/desktop/${name}.cjs`,format:'cjs'});}
 finally {await bundle.close();}
}
