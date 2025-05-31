const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3006;

// MongoDB connection configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = 'off';
const COLLECTION_NAME = 'products';

let db;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.originalUrl;
  const userAgent = req.get('User-Agent') || 'Unknown';
  
  console.log(`[${timestamp}] ${method} ${url} - ${req.ip} - ${userAgent}`);
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    console.log(`[${timestamp}] ${method} ${url} - ${res.statusCode} - ${duration}ms`);
  });
  
  req.startTime = Date.now();
  next();
});

// Connect to MongoDB
async function connectToMongo() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DATABASE_NAME);
    console.log(`Connected to MongoDB database: ${DATABASE_NAME}`);
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    database: db ? 'Connected' : 'Disconnected',
    timestamp: new Date().toISOString()
  });
});

// Helper function to normalize barcode format
function normalizeBarcode(barcode) {
  // Remove any non-digit characters
  const cleanBarcode = barcode.replace(/\D/g, '');
  
  // If it's 12 digits (UPC-A), add leading zero to make it EAN-13
  if (cleanBarcode.length === 12) {
    return '0' + cleanBarcode;
  }
  
  // Return as-is for other lengths (EAN-8, EAN-13, etc.)
  return cleanBarcode;
}

// Get product by barcode
app.get('/product/:barcode', async (req, res) => {
  try {
    const inputBarcode = req.params.barcode;
    
    // Validate barcode (basic validation)
    if (!inputBarcode || inputBarcode.length < 8 || inputBarcode.length > 14) {
      return res.status(400).json({
        error: 'Invalid barcode',
        message: 'Barcode must be between 8 and 14 digits'
      });
    }

    // Normalize the barcode (convert UPC-A to EAN-13 if needed)
    const normalizedBarcode = normalizeBarcode(inputBarcode);
    
    // Try multiple barcode formats
    const collection = db.collection(COLLECTION_NAME);
    let product = await collection.findOne({ code: normalizedBarcode });
    
    // If not found with normalized version, try original
    if (!product && normalizedBarcode !== inputBarcode) {
      product = await collection.findOne({ code: inputBarcode });
    }
    
    // If still not found and input was 13 digits, try removing leading zero
    if (!product && inputBarcode.length === 13 && inputBarcode.startsWith('0')) {
      const withoutLeadingZero = inputBarcode.substring(1);
      product = await collection.findOne({ code: withoutLeadingZero });
    }

    if (!product) {
      return res.status(404).json({
        error: 'Product not found',
        message: `No product found with barcode: ${inputBarcode} (also tried: ${normalizedBarcode})`
      });
    }

    // Return clean product data
    res.json({
      success: true,
      barcode_searched: inputBarcode,
      barcode_found: product.code,
      product: {
        barcode: product.code,
        name: product.product_name || 'Unknown',
        brands: product.brands || 'Unknown',
        categories: product.categories || 'Unknown',
        ingredients: product.ingredients_text || 'Not available',
        nutrition_grade: product.nutrition_grades || 'Unknown',
        countries: product.countries || 'Unknown',
        image_url: product.image_url || null,
        nutrition_facts: {
          energy_100g: product.energy_100g || null,
          fat_100g: product.fat_100g || null,
          saturated_fat_100g: product['saturated-fat_100g'] || null,
          carbohydrates_100g: product.carbohydrates_100g || null,
          sugars_100g: product.sugars_100g || null,
          fiber_100g: product.fiber_100g || null,
          proteins_100g: product.proteins_100g || null,
          salt_100g: product.salt_100g || null,
          sodium_100g: product.sodium_100g || null
        },
        // Include raw data for advanced users
        raw_data: product
      }
    });

  } catch (error) {
    console.error('Error querying product:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to query database'
    });
  }
});

// Search products by name (bonus endpoint)
app.get('/search', async (req, res) => {
  try {
    const query = req.query.q;
    const limit = parseInt(req.query.limit) || 10;
    
    if (!query) {
      return res.status(400).json({
        error: 'Missing query parameter',
        message: 'Please provide a search query using ?q=your_search_term'
      });
    }

    const collection = db.collection(COLLECTION_NAME);
    
    // Search by product name (case insensitive)
    const products = await collection
      .find({ 
        product_name: { $regex: query, $options: 'i' }
      })
      .limit(limit)
      .toArray();

    res.json({
      success: true,
      query: query,
      count: products.length,
      products: products.map(product => ({
        barcode: product.code,
        name: product.product_name,
        brands: product.brands,
        categories: product.categories,
        nutrition_grade: product.nutrition_grades,
        image_url: product.image_url
      }))
    });

  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to search database'
    });
  }
});

// Get database statistics (bonus endpoint)
app.get('/stats', async (req, res) => {
  try {
    const collection = db.collection(COLLECTION_NAME);
    
    const totalProducts = await collection.countDocuments();
    const productsWithImages = await collection.countDocuments({ image_url: { $exists: true, $ne: null } });
    const productsWithGrades = await collection.countDocuments({ nutrition_grades: { $exists: true, $ne: null } });
    
    // Top 5 brands by product count
    const topBrands = await collection.aggregate([
      { $match: { brands: { $exists: true, $ne: "" } } },
      { $group: { _id: "$brands", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]).toArray();

    res.json({
      success: true,
      statistics: {
        total_products: totalProducts,
        products_with_images: productsWithImages,
        products_with_nutrition_grades: productsWithGrades,
        top_brands: topBrands
      }
    });

  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get database statistics'
    });
  }
});

// Root endpoint with API documentation
app.get('/', (req, res) => {
  res.json({
    message: 'Open Food Facts API Server',
    version: '1.0.0',
    endpoints: {
      'GET /': 'This documentation',
      'GET /health': 'Health check',
      'GET /product/:barcode': 'Get product by barcode',
      'GET /search?q=query&limit=10': 'Search products by name',
      'GET /stats': 'Database statistics'
    },
    examples: {
      product: '/product/3017620422003',
      search: '/search?q=coca%20cola&limit=5'
    }
  });
});

// Start server
async function startServer() {
  await connectToMongo();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Open Food Facts API Server running on port ${PORT}`);
    console.log(`🌐 Server accessible from all IP addresses`);
    console.log(`📖 API Documentation: http://localhost:${PORT}/`);
    console.log(`🔍 Example product lookup: http://localhost:${PORT}/product/3017620422003`);
    console.log(`📊 Database stats: http://localhost:${PORT}/stats`);
  });
}

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down server...');
  process.exit(0);
});

// Start the server
startServer().catch(console.error);
