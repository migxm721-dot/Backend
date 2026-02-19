module.exports = {
  minAppVersion: '1.0.0',
  
  compareVersions: (version, minVersion) => {
    const v1 = version.split('.').map(Number);
    const v2 = minVersion.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (v1[i] > v2[i]) return 1;
      if (v1[i] < v2[i]) return -1;
    }
    return 0;
  },
  
  isVersionAllowed: function(appVersion) {
    if (!appVersion) return false;
    return this.compareVersions(appVersion, this.minAppVersion) >= 0;
  }
};
