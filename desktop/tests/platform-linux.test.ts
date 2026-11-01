import { testFeatures } from './platform-features';
import { linux } from './platforms/linux';

// Every app feature in platform-features.ts, with linux's own drives, paths and filesystem.
testFeatures(linux);
