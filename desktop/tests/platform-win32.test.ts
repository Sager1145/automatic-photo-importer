import { testFeatures } from './platform-features';
import { win32 } from './platforms/win32';

// Every app feature in platform-features.ts, with win32's own drives, paths and filesystem.
testFeatures(win32);
