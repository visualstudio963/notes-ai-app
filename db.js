const { MongoClient } = require("mongodb");

const uri = "mongodb+srv://redoncapoku_db_user:Eldaredi.2021@cluster0.znzsitw.mongodb.net/";

const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB!");

    const db = client.db("testDB");
    const users = db.collection("users");

    await users.insertOne({ name: "Redon", age: 21 });

    const data = await users.find().toArray();
    console.log(data);
  } finally {
    await client.close();
  }
}

run().catch(error => {
  console.error("MongoDB error:", error);
});