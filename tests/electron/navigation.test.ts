import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { externalUrl } from '../../electron/shared/src/index.ts'

describe('external navigation policy', () => {
  it('lets the two web schemes through', () => {
    assert.equal(externalUrl('https://github.com/acme/eval'), 'https://github.com/acme/eval')
    assert.equal(externalUrl('http://localhost:8787/health'), 'http://localhost:8787/health')
  })

  it('refuses every other scheme the OS would otherwise resolve', () => {
    for (const url of [
      'file:///etc/passwd',
      'smb://attacker.example/share',
      'javascript:alert(1)',
      'ms-msdt:/id',
      'vscode://file/etc/passwd',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      assert.equal(externalUrl(url), null, url)
    }
  })

  it('refuses anything that is not a URL', () => {
    assert.equal(externalUrl(''), null)
    assert.equal(externalUrl('not a url'), null)
  })
})
