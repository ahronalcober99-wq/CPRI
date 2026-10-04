import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSubmissionFileStore,
  MAX_SUBMISSION_FILE_BYTES,
  validateSubmissionUploadFile
} from '../storage/submission-files.js';

test('accepts only PDF, DOC, and DOCX with matching MIME types', () => {
  assert.equal(validateSubmissionUploadFile({ originalname: 'paper.PDF', mimetype: 'application/pdf' }), true);
  assert.equal(validateSubmissionUploadFile({ originalname: 'paper.doc', mimetype: 'application/msword' }), true);
  assert.equal(validateSubmissionUploadFile({
    originalname: 'paper.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }), true);
  assert.equal(validateSubmissionUploadFile({ originalname: 'paper.exe', mimetype: 'application/pdf' }), false);
  assert.equal(validateSubmissionUploadFile({ originalname: 'paper.pdf', mimetype: 'text/plain' }), false);
  assert.equal(validateSubmissionUploadFile({
    originalname: 'paper.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('not a PDF')
  }), false);
  assert.equal(validateSubmissionUploadFile({
    originalname: 'paper.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-')
  }), true);
  assert.equal(MAX_SUBMISSION_FILE_BYTES, 15 * 1024 * 1024);
});

test('stores files under random paths and preserves original metadata', async () => {
  const uploads = [];
  const storage = {
    async uploadObject(input) { uploads.push(input); },
    async deleteObjects() {}
  };
  const fileStore = createSubmissionFileStore({ storage });
  const pdfBuffer = Buffer.from('%PDF-manuscript bytes');
  const docxBuffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00]);
  const result = await fileStore.storeUploadedFiles({
    manuscript: [{
      originalname: 'private-research-paper.pdf',
      mimetype: 'application/pdf',
      buffer: pdfBuffer
    }],
    additional: [{
      originalname: 'appendix.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: docxBuffer
    }]
  }, 'submissions/test-id');

  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].buffer, pdfBuffer);
  assert.match(result.files.manuscript.storage_path, /^submissions\/test-id\/[0-9a-f-]+\.pdf$/);
  assert.equal(result.files.manuscript.storage_path.includes('private-research-paper'), false);
  assert.equal(result.files.manuscript.original_name, 'private-research-paper.pdf');
  assert.equal(result.files.manuscript.mime_type, 'application/pdf');
  assert.equal(result.additionalDocs[0].storage_path.includes('appendix'), false);
  assert.equal(result.additionalDocs[0].original_name, 'appendix.docx');
});

test('removes successfully uploaded objects if a later upload fails', async () => {
  const deleted = [];
  let uploadCount = 0;
  const storage = {
    async uploadObject() {
      uploadCount += 1;
      if (uploadCount === 2) throw new Error('storage unavailable');
    },
    async deleteObjects(paths) { deleted.push(...paths); }
  };
  const fileStore = createSubmissionFileStore({ storage });
  await assert.rejects(fileStore.storeUploadedFiles({
    manuscript: [{
      originalname: 'paper.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-first')
    }],
    abstract: [{
      originalname: 'abstract.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-second')
    }]
  }, 'submissions/test-id'), /storage unavailable/);

  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /^submissions\/test-id\/[0-9a-f-]+\.pdf$/);
});
