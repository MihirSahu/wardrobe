// Acknowledge each upload before starting the next so a partial retry sends
// only failed or unattempted photos. A rejected upload remains pending.
export async function uploadPhotoBatch(photos, upload, acknowledge) {
  for (const photo of photos) {
    const result = await upload(photo.file);
    acknowledge(photo, result);
  }
}
