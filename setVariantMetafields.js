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

// Helper function to delay (used for rate-limiting)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAllProducts() {
  let products = [];
  let pageInfo = null;

  do {
    try {
      const response = await axiosInstance.get('/products.json', {
        params: {
          limit: 250,
          ...(pageInfo ? { page_info: pageInfo } : {}),
        },
      });

      products = products.concat(response.data.products);
      const linkHeader = response.headers.link;

      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^&>]+)/);
        pageInfo = match ? match[1] : null;
      } else {
        pageInfo = null;
      }
    } catch (error) {
      console.error('❌ Error fetching products:', error.response?.data || error.message);
      break;
    }
  } while (pageInfo);

  return products;
}

async function setVariantGenderMetafield(variantId, productId) {
  try {
    const metafield = {
      metafield: {
        namespace: 'mm-google-shopping',
        key: 'color',
        value: 'multicolor',
        type: 'single_line_text_field',
      },
    };

    await axiosInstance.post(`/variants/${variantId}/metafields.json`, metafield);
    console.log(`✅ Set gender=female metafield for variant ${variantId} (Product ID: ${productId})`);
  } catch (error) {
    const message = error.response?.data?.errors || error.message;
    console.error(`❌ Failed for variant ${variantId}:`, message);
  }
}

async function run() {
  const products = await getAllProducts();
  console.log(`Found ${products.length} products`);

  for (const product of products) {
    for (const variant of product.variants) {
      await setVariantGenderMetafield(variant.id, product.id);
      await delay(500); // Respect API rate limit
    }
  }
}

run();
