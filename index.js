require("dotenv").config();

const express = require("express");
const app = express();
const port = process.env.PORT || 5000;
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGODB_URI, {
  maxPoolSize: 10,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 15000,
});

const database = client.db("Marcateplace2");
let productCollection = database.collection("products");

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    productCollection = database.collection("products");
    // Create helpful indexes (idempotent).
    try {
      await productCollection.createIndex({ categorySlug: 1, isActive: 1 });
      await productCollection.createIndex({ price: 1 });
      await productCollection.createIndex({ createdAt: -1 });
      await productCollection.createIndex({ rating: -1, reviewsCount: -1 });
      await productCollection.createIndex({ sold: -1 });
      await productCollection.createIndex({ discount: -1 });
      await productCollection.createIndex({ title: 1 });
    } catch (idxErr) {
      console.warn("[indexes] ", idxErr.message);
    }
  } catch (err) {
    console.dir(err);
  }
}

/** Escape user input so it is safe to use inside a MongoDB $regex. */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a MongoDB filter from the public query parameters. */
function buildProductFilter({ search, category, subCategory, minPrice, maxPrice, minRating, minDiscount, inStock } = {}) {
  const query = { isActive: { $ne: false } };
  const and = [];

  if (search) {
    const safe = escapeRegex(search);
    and.push({
      $or: [
        { title: { $regex: safe, $options: "i" } },
        { slug: { $regex: safe, $options: "i" } },
        { category: { $regex: safe, $options: "i" } },
        { subCategory: { $regex: safe, $options: "i" } },
        { brand: { $regex: safe, $options: "i" } },
        { description: { $regex: safe, $options: "i" } },
      ],
    });
  }

  if (category && category !== "all" && category !== "All Categories") {
    and.push({
      $or: [
        { categorySlug: category },
        { category: { $regex: new RegExp(`^${escapeRegex(category)}$`, "i") } },
        { subCategory: { $regex: new RegExp(`^${escapeRegex(category)}$`, "i") } },
      ],
    });
  }

  if (subCategory && subCategory !== "all" && subCategory !== "All Subcategories") {
    and.push({ subCategory: subCategory });
  }

  if (minPrice !== undefined || maxPrice !== undefined) {
    const range = {};
    if (minPrice !== undefined) range.$gte = Number(minPrice);
    if (maxPrice !== undefined) range.$lte = Number(maxPrice);
    and.push({ price: range });
  }

  if (minRating !== undefined && Number(minRating) > 0) {
    query.rating = { $gte: Number(minRating) };
  }

  if (minDiscount !== undefined && Number(minDiscount) > 0) {
    and.push({
      $expr: {
        $gt: [
          { $subtract: ["$price", { $ifNull: ["$discountPrice", 0] }] },
          { $multiply: ["$price", Number(minDiscount) / 100] },
        ],
      },
    });
  }

  if (inStock === true || inStock === "1" || inStock === "true") {
    and.push({ stock: { $gt: 0 } });
  }

  if (and.length) query.$and = and;
  return query;
}

/** Map public sort values to MongoDB sort specifications. */
function getSortSpec(sort) {
  switch (sort) {
    case "price-low-to-high":
      return { price: 1, _id: 1 };
    case "price-high-to-low":
      return { price: -1, _id: 1 };
    case "newest":
      return { createdAt: -1, _id: -1 };
    case "oldest":
      return { createdAt: 1, _id: 1 };
    case "best-selling":
      return { sold: -1, rating: -1, _id: -1 };
    case "highest-rated":
      return { rating: -1, reviewsCount: -1, _id: -1 };
    case "biggest-discount":
      return { discount: -1, price: -1, _id: -1 };
    case "featured":
    default:
      return { rating: -1, reviewsCount: -1, _id: -1 };
  }
}

/** Serialize a product document so the client receives plain JSON (no BSON types). */
function serializeProduct(product) {
  if (!product) return null;
  const price = Math.round((Number(product.price) || 0) * 100) / 100;
  const discountPrice = product.discountPrice == null ? null : Math.round(Number(product.discountPrice) * 100) / 100;
  const salePrice =
    discountPrice != null && discountPrice > 0 && discountPrice < price ? discountPrice : price;
  const discount = product.discount != null ? Number(product.discount) || 0 : price > 0 ? Math.round(((price - salePrice) / price) * 100) : 0;

  return {
    ...product,
    _id: String(product._id),
    id: product.id ?? String(product._id),
    price,
    oldPrice: product.oldPrice != null ? Math.round(Number(product.oldPrice) * 100) / 100 : price,
    discountPrice,
    salePrice,
    discount,
    stock: Number(product.stock) || 0,
    sold: Number(product.sold) || 0,
    rating: Number(product.rating) || 0,
    reviewsCount: Number(product.reviewsCount) || 0,
    isActive: product.isActive !== false,
    inStock: (Number(product.stock) || 0) > 0 && product.isActive !== false,
    images: Array.isArray(product.images) ? product.images : product.images ? [product.images] : [],
    brand: product.brand || "",
    category: product.category || "",
    subCategory: product.subCategory || "",
    categorySlug: product.categorySlug || "",
    title: product.title || "",
    slug: product.slug || "",
    description: product.description || "",
    createdAt: product.createdAt || null,
    updatedAt: product.updatedAt || null,
  };
}

app.get("/", (req, res) => {
  res.send("Hello World!");
});

/**
 * GET /products
 * Public product catalog with search, sort, category filter and pagination.
 *
 * Query params:
 *   search, category, subCategory, minPrice, maxPrice, minRating, minDiscount, inStock
 *   sort: featured | price-low-to-high | price-high-to-low | newest | oldest |
 *         best-selling | highest-rated | biggest-discount
 *   page, limit
 */
app.get("/products", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || "12", 10) || 12));
    const sort = req.query.sort || "featured";
    const search = req.query.search || undefined;
    const category = req.query.category || undefined;
    const subCategory = req.query.subCategory || undefined;

    const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : undefined;
    const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : undefined;
    const minRating = req.query.minRating !== undefined ? Number(req.query.minRating) : undefined;
    const minDiscount = req.query.minDiscount !== undefined ? Number(req.query.minDiscount) : undefined;
    const inStock = req.query.inStock === "1" || req.query.inStock === "true";

    const filter = buildProductFilter({ search, category, subCategory, minPrice, maxPrice, minRating, minDiscount, inStock });
    const sortSpec = getSortSpec(sort);

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      productCollection
        .find(filter)
        .sort(sortSpec)
        .skip(skip)
        .limit(limit)
        .toArray(),
      productCollection.countDocuments(filter),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.json({
      success: true,
      items: items.map(serializeProduct),
      total,
      page,
      limit,
      totalPages,
      hasMore: page * limit < total,
      sort,
      search: search || "",
      category: category || "",
    });
  } catch (err) {
    console.error("[GET /products] error:", err);
    return res.status(500).json({ success: false, message: "Failed to load products." });
  }
});

app.get("/Carts", async (req, res) => {
  const cartdatabase = database.collection("addcartdata");
  const cartItems = await cartdatabase.find({}).toArray();
  res.send(cartItems);
});

app.get("/products/:id", async (req, res) => {
  try {
    let product;
    if (ObjectId.isValid(req.params.id)) {
      product = await productCollection.findOne({ _id: new ObjectId(req.params.id) });
    }
    if (!product) {
      product = await productCollection.findOne({ _id: req.params.id });
    }
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }
    return res.json({ success: true, product: serializeProduct(product) });
  } catch (err) {
    console.error("[GET /products/:id] error:", err);
    return res.status(500).json({ success: false, message: "Failed to load product." });
  }
});

app.post("/addcartdata", async (req, res) => {
  const cartdatabase = database.collection("addcartdata");
  const cartData = req.body;
  const result = await cartdatabase.insertOne(cartData);
  res.send(result);
});

connectToMongoDB();

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
