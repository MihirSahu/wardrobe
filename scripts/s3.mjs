import { S3Client, HeadBucketCommand, CreateBucketCommand, PutPublicAccessBlockCommand, PutBucketOwnershipControlsCommand, PutBucketEncryptionCommand, PutBucketVersioningCommand, PutBucketLifecycleConfigurationCommand } from "@aws-sdk/client-s3";
import { restore } from "../server/backup.mjs";
import path from "node:path";

const [action, ...args] = process.argv.slice(2);
const option = (key) => { const index = args.indexOf(`--${key}`); return index >= 0 ? args[index + 1] : null; };
const bucket = option("bucket"); const region = option("region");
if (!bucket || !region || !["provision", "restore"].includes(action)) {
  console.error("Usage: sfw pnpm s3 provision --bucket NAME --region REGION\n       sfw pnpm s3 restore --bucket NAME --region REGION --snapshot ID --destination NEW_DIRECTORY"); process.exitCode = 1;
} else {
  const client = new S3Client({ region, maxAttempts: 3 });
  try {
    if (action === "provision") {
      // In us-east-1 CreateBucket can succeed for an already-owned bucket. Check first.
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        throw new Error("This bucket already exists. Supply a new globally unique bucket name.");
      } catch (error) {
        if (error.$metadata?.httpStatusCode !== 404) throw error;
      }
      await client.send(new CreateBucketCommand({ Bucket: bucket, ...(region !== "us-east-1" ? { CreateBucketConfiguration: { LocationConstraint: region } } : {}), ObjectOwnership: "BucketOwnerEnforced" }));
      await client.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
      await client.send(new PutBucketOwnershipControlsCommand({ Bucket: bucket, OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } }));
      await client.send(new PutBucketEncryptionCommand({ Bucket: bucket, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: false }] } }));
      await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
      await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: [
        { ID: "snapshot-retention", Status: "Enabled", Filter: { Prefix: "snapshots/" }, Expiration: { Days: 30 }, NoncurrentVersionExpiration: { NoncurrentDays: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
        { ID: "expired-markers", Status: "Enabled", Filter: { Prefix: "snapshots/" }, Expiration: { ExpiredObjectDeleteMarker: true } },
      ] } }));
      console.log(`Configured private, encrypted, versioned bucket ${bucket} in ${region}. Snapshots expire after 30 days; prior versions expire 30 days after becoming noncurrent.`);
    } else {
      const id = option("snapshot"); const destination = option("destination"); if (!id || !destination) throw new Error("Supply --snapshot and --destination");
      const manifest = await restore({ client, bucket, id, destination, workDir: path.resolve(".state/restore") });
      console.log(`Verified ${manifest.files.length} entries in ${path.resolve(destination)}. Stop Wardrobe before replacing its data directory.`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
