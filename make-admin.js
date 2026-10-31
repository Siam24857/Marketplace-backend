require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);

  try {
    await client.connect();

    const db = client.db('Marcateplace2');

    const result = await db.collection('user').updateOne(
      { email: 'email@example.com' },
      {
        $set: {
          role: 'admin',
          updatedAt: new Date()
        }
      }
    );

    console.log('Matched:', result.matchedCount);
    console.log('Modified:', result.modifiedCount);
  } catch (error) {
    console.error(error);
  } finally {
    await client.close();
  }
})();