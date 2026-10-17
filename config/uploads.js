const mongoose = require("mongoose");

// (mongoose.mongo is the MongoDB driver mongoose already ships with, so no separate
// 'mongodb' package is needed and the two can never be different versions.)
// Files are stored inside MongoDB itself (GridFS), not on local disk.
// This survives restarts/redeploys on hosts with no persistent disk, like Render's free tier.
let bucket;
function getBucket() {
  if (!bucket)
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "submissions",
    });
  return bucket;
}

module.exports = { getBucket };
