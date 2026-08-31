'use strict';
// A real 32x32 tray icon. Electron's Tray will happily accept an empty image and
// then render a slot you can see nothing in and cannot click - which looks
// exactly like a stray invisible window sitting in your notification area.
module.exports.TRAY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABGUlEQVR4nO2XvQnDMBCFVaVNpwnSeQcPkELgHbyD2yziSgt4Iq+SYKPCKPfzdP4RhAgOXAjed6fT09m5/zIsH0PjY+h8DH2K5bs5W7T1MYw+hrcSy572SOEl2wkQzmPaXZVUXlbkOb/WUEB6q/jACWpBQAy7M0fFBQisEunMd4kLEHpP5A1nFWcgJk28LRG/Pe5rFELwV3R7z5HsUIAMYpQAirO3VAFqvjMByGZMfg4B5OIIRAbQUQC9NXtDFb49AQXgxAurQAJAR2AFQI5AbUJNXIKAHPEqAMkHRCM6CEA0ItaKUXEKArZiJzxGVoCix4hqxsufY1d7INlA1BvJpEpQQNIe81C6gag3lmcgdX5MGJjrf81+dn0A5Pr4h1qAP2UAAAAASUVORK5CYII=';
