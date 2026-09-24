async function runTests() {
  const baseURL = 'https://nexusfmsbackednshrikant-production.up.railway.app/api/v1';
  let token = '';

  try {
    console.log('1. Login as Admin...');
    const loginRes = await fetch(`${baseURL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@nexusfms.com', password: 'Password123!' })
    });
    const loginData = await loginRes.json();
    console.log('Login Response:', loginData);
    token = loginData.token || loginData.data?.token;
    console.log('✅ Logged in successfully. Token length:', token ? token.length : 'none');

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    console.log('\\n2. Create Inventory Item...');
    const createRes = await fetch(`${baseURL}/inventory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        itemName: 'Test Pipe',
        currentQuantity: 5,
        minThreshold: 10,
        unit: 'pcs'
      })
    });
    const createData = await createRes.json();
    if (!createRes.ok) {
      throw new Error(`Create failed: ${JSON.stringify(createData)}`);
    }
    const itemId = createData.data.id;
    console.log('✅ Item created. ID:', itemId);

    console.log('\\n3. Verify Low Stock Status...');
    const getRes = await fetch(`${baseURL}/inventory/${itemId}`, { headers });
    const getData = await getRes.json();
    const item = getData.data;
    if (item.stockStatus === 'LOW STOCK') {
      console.log('✅ Status correctly identified as LOW STOCK.');
    } else {
      console.error('❌ Status should be LOW STOCK but is', item.stockStatus);
    }

    console.log('\\n4. Restock Item (Add 20)...');
    const restockRes = await fetch(`${baseURL}/inventory/${itemId}/restock`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ quantity: 20 })
    });

    console.log('\\n5. Verify Normal Stock Status...');
    const getRes2 = await fetch(`${baseURL}/inventory/${itemId}`, { headers });
    const getData2 = await getRes2.json();
    const updatedItem = getData2.data;

    if (updatedItem.currentQuantity === 25) {
      console.log('✅ Quantity correctly updated to 25.');
    } else {
      console.error('❌ Quantity incorrect. Expected 25, got', updatedItem.currentQuantity);
    }

    if (updatedItem.stockStatus === 'NORMAL') {
      console.log('✅ Status correctly identified as NORMAL.');
    } else {
      console.error('❌ Status should be NORMAL but is', updatedItem.stockStatus);
    }

    console.log('\\n6. Test Unauthorized Access (Login as Tenant)...');
    const tenantLogin = await fetch(`${baseURL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'staff@nexusfms.com', password: 'Password123!' })
    });
    const tenantData = await tenantLogin.json();

    const unauthGetRes = await fetch(`${baseURL}/inventory`, {
      headers: { Authorization: `Bearer ${tenantData.token}` }
    });

    if (unauthGetRes.status === 403) {
      console.log('✅ Tenant blocked from accessing inventory (403 Forbidden).');
    } else {
      console.error('❌ Expected 403, got', unauthGetRes.status);
    }

    console.log('\\n🎉 All Tests Passed successfully!');

  } catch (error) {
    console.error('❌ Test Failed:', error);
  }
}

runTests();
