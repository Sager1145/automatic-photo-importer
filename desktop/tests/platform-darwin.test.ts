import { testFeatures } from './platform-features';
import { darwin } from './platforms/darwin';

// Every app feature in platform-features.ts, with darwin's own drives, paths and filesystem.
testFeatures(darwin);
