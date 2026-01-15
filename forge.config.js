const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    name: 'KioskSystem',
    asar: true,

    // 🔥 QUAN TRỌNG: cho phép mang file .ps1 ra ngoài app.asar
    extraResource: [
      'lock-kiosk.ps1',
      'unlock-kiosk.ps1'
    ],
  },

  rebuildConfig: {},

  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'kiosk_client',
        exe: 'KioskSystem.exe',
        setupExe: 'KioskInstaller.exe',

        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        runAfterFinish: true,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],

  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },

    // 🔒 FUSE SECURITY – GIỮ NGUYÊN
    new FusesPlugin({
      version: FuseVersion.V1,

      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,

      // ⚠️ RẤT QUAN TRỌNG
      // Cho phép load resource ngoài asar (extraResource)
      [FuseV1Options.OnlyLoadAppFromAsar]: false,

      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    }),
  ],
};
