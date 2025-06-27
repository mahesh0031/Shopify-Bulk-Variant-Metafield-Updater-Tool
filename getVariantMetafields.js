require('dotenv').config();
const axios = require('axios');

const API_VERSION = '2024-01';
const store = process.env.SHOPIFY_STORE;
const accessToken = process.env.SHOPIFY_API_KEY;

const axiosInstance = axios.create({
  baseURL: `https://${store}/admin/api/${API_VERSION}`,
  headers: {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  },
});

// Replace this with your variant ID
const VARIANT_ID = '42657614889132';

async function getVariantMetafields(variantId) {
  try {
    const response = await axiosInstance.get(`/variants/${variantId}/metafields.json`);
    const metafields = response.data.metafields;

    if (metafields.length === 0) {
      console.log(`⚠️ No metafields found for variant ${variantId}`);
      return;
    }

    console.log(`🧩 All metafields for variant ${variantId}:\n`);
    metafields.forEach((field, index) => {
      console.log(
        `${index + 1}.\n` +
        `  Namespace: "${field.namespace}"\n` +
        `  Key: "${field.key}"\n` +
        `  Value: "${field.value}"\n` +
        `  Type: "${field.type}"\n` +
        `  ID: ${field.id}\n`
      );
    });
  } catch (error) {
    const msg = error.response?.data?.errors || error.message;
    console.error(`❌ Error fetching metafields for variant ${variantId}:`, msg);
  }
}

getVariantMetafields(VARIANT_ID);
