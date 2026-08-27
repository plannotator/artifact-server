#!/usr/bin/env node

import {tsImport} from "tsx/esm/api";

await tsImport("../index.ts", import.meta.url);
