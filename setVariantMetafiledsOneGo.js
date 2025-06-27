require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');
const https = require('https');
const xml2js = require('xml2js');
const util = require('util');

const API_VERSION = '2024-01';
const store = process.env.SHOPIFY_STORE;
const accessToken = process.env.SHOPIFY_API_KEY;
const parseStringAsync = util.promisify(xml2js.parseString);

const axiosInstance = axios.create({
  baseURL: `https://${store}/admin/api/${API_VERSION}`,
  headers: {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  },
});

async function getAllVariants() {
  let products = [];
  let pageInfo = null;

  do {
    const res = await axiosInstance.get('/products.json', {
      params: {
        limit: 250,
        ...(pageInfo ? { page_info: pageInfo } : {}),
      },
    });

    products = products.concat(res.data.products);

    const linkHeader = res.headers.link;
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/page_info=([^&>]+)/);
      pageInfo = match ? match[1] : null;
    } else {
      pageInfo = null;
    }
  } while (pageInfo);

  const variants = products.flatMap(product =>
    product.variants.map(v => ({
      id: v.id,
      gid: `gid://shopify/ProductVariant/${v.id}`,
    }))
  );

  console.log(`✅ Found ${variants.length} variants`);
  return variants;
}

function createJsonlFile(variants, filePath) {
  const stream = fs.createWriteStream(filePath);
  for (const variant of variants) {
    const mutationLine = {
      input: {
        ownerId: variant.gid,
        namespace: 'mm-google-shopping',
        key: 'custom_label_4',
        type: 'single_line_text_field',
        value: 'blank',
      },
    };
    stream.write(JSON.stringify({ input: mutationLine.input }) + '\n');
  }
  stream.end();
  console.log(`✅ JSONL file written: ${filePath}`);
}

async function getStagedUploadPath(xml) {
  try {
    const result = await parseStringAsync(xml);
    return result?.PostResponse?.Key?.[0] || null;
  } catch (err) {
    console.error('❌ Error parsing XML:', err.message);
    return null;
  }
}

async function uploadAndTriggerBulk(filePath) {
  // Step 1: Request staged upload target
  const uploadRes = await axiosInstance.post('/graphql.json', {
    query: `mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES,
        filename: "bulk_metafields.jsonl",
        mimeType: "text/jsonl",
        httpMethod: POST
      }]) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
  });

  const target = uploadRes.data.data.stagedUploadsCreate.stagedTargets[0];

  // Step 2: Upload the JSONL file
  const form = new FormData();
  target.parameters.forEach(param => form.append(param.name, param.value));
  form.append('file', fs.createReadStream(filePath));

  const uploadResponse = await axios.post(target.url, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000,
    httpsAgent: new https.Agent({ keepAlive: true }),
  });

  console.log('✅ File uploaded to Shopify staging');

  const stagedUploadPath = await getStagedUploadPath(uploadResponse.data);
  if (!stagedUploadPath) throw new Error('❌ Could not extract stagedUploadPath from XML');

  // Step 3: Trigger bulk mutation
  const mutation = `
    mutation bulkOperationRunMutation($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation metafieldSet($input: MetafieldsSetInput!) { metafieldsSet(metafields: [$input]) { userErrors { field message } } }",
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const triggerRes = await axiosInstance.post('/graphql.json', {
    query: mutation,
    variables: { stagedUploadPath },
  });

  console.log('🚀 Bulk mutation triggered:');
  console.dir(triggerRes.data, { depth: null });
}

(async () => {
  try {
    const filePath = path.resolve(__dirname, 'bulk_metafields.jsonl');
    const variants = await getAllVariants();
    createJsonlFile(variants, filePath);
    await uploadAndTriggerBulk(filePath);
  } catch (err) {
    console.error('❌ Fatal Error:');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    } else if (err.request) {
      console.error('No response:', err.request);
    } else {
      console.error('Error:', err.message);
    }
    console.error('Stack:', err.stack);
  }
})();
