-- Mettre à jour le bucket cv-uploads pour accepter DOC et PPT
UPDATE storage.buckets 
SET allowed_mime_types = ARRAY[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint'
]
WHERE id = 'cv-uploads';