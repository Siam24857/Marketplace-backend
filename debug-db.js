const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');
dotenv.config({ path: '../Maecateplace1/.env' });
async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('Marcateplace2');
  
  const collections = await db.listCollections().toArray();
  console.log('Collections:', collections.map(c => c.name));
  
  const products = await db.collection('products').find().limit(10).toArray();
  console.log('Products count:', await db.collection('products').countDocuments());
  console.log('Sample products:');
  products.forEach(p => {
    console.log(JSON.stringify({
      _id: p._id,
      title: p.title,
      slug: p.slug,
      category: p.category,
      subCategory: p.subCategory,
      categorySlug: p.categorySlug,
      categoryId: p.categoryId,
      stock: p.stock,
      isActive: p.isActive,
      price: p.price,
      discountPrice: p.discountPrice,
      sold: p.sold,
    }));
  });
  
  await client.close();
}
main().catch(console.error);