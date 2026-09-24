const assert = require('assert');
const {
  getCloudinaryConfig,
  clearConfigCache,
  uploadMediaFile,
  testCloudinaryConnection,
} = require('./services/cloudinary.service');

async function runTests() {
  console.log('================================================================');
  console.log('🧪 TESTING CLOUDINARY INTEGRATION & FALLBACK LOGIC');
  console.log('================================================================\n');

  // Test 1: Configuration structure
  console.log('1. Testing getCloudinaryConfig()...');
  const config = await getCloudinaryConfig();
  assert.ok(typeof config === 'object', 'Config must be an object');
  assert.ok('active' in config, 'Config must have active flag');
  assert.ok('isEnabled' in config, 'Config must have isEnabled flag');
  assert.ok('cloudName' in config, 'Config must have cloudName');
  assert.ok('apiKey' in config, 'Config must have apiKey');
  assert.ok('apiSecret' in config, 'Config must have apiSecret');
  console.log('✅ Config structure verified:', {
    active: config.active,
    isEnabled: config.isEnabled,
    hasCredentials: config.hasCredentials,
  });

  // Test 2: Fallback when Cloudinary is inactive/unconfigured
  console.log('\n2. Testing uploadMediaFile fallback to local storage...');
  const mockFile = {
    filename: 'test-photo-12345.jpg',
    originalname: 'kitchen_leak.jpg',
    path: 'uploads/test-photo-12345.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
  };

  const uploadResult = await uploadMediaFile(mockFile, 'quotes');
  assert.ok(uploadResult, 'Must return upload result');
  assert.ok(uploadResult.url, 'Must have url');
  if (!config.active) {
    assert.strictEqual(uploadResult.provider, 'LOCAL', 'Must use LOCAL provider when Cloudinary unconfigured');
    assert.strictEqual(uploadResult.url, '/uploads/test-photo-12345.jpg', 'Must return local relative url');
    console.log('✅ Fallback to local storage succeeded:', uploadResult);
  } else {
    console.log('✅ Cloudinary is active in environment, upload returned:', uploadResult);
  }

  // Test 3: testCloudinaryConnection validation
  console.log('\n3. Testing testCloudinaryConnection validation...');
  const emptyRes = await testCloudinaryConnection({ cloudName: '', apiKey: '', apiSecret: '' });
  assert.strictEqual(emptyRes.success, false);
  assert.ok(emptyRes.error, 'Must report missing fields error');
  console.log('✅ Empty credentials rejected correctly:', emptyRes.error);

  const invalidRes = await testCloudinaryConnection({
    cloudName: 'invalid_cloud_test_123',
    apiKey: '999999999999',
    apiSecret: 'invalid_secret_test_xyz',
  });
  assert.strictEqual(invalidRes.success, false);
  assert.ok(invalidRes.error, 'Invalid credentials must return error');
  console.log('✅ Invalid credentials safely caught without crash:', invalidRes.error);

  console.log('\n================================================================');
  console.log('🎉 ALL CLOUDINARY INTEGRATION TESTS PASSED!');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
