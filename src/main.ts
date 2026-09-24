import { App } from './app/app';

// Single entry point: builds the scene, HUD and a menu backdrop simulation.
const app = new App();
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
