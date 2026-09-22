// Loading state on form submit buttons
document.addEventListener('submit', function(e) {
  var form = e.target;
  // Find the button that triggered the submit (if via formaction) or the default submit button
  var btn = form.querySelector('button[type="submit"]:focus') || document.activeElement;
  if (btn && btn.tagName === 'BUTTON' && btn.type === 'submit') {
    btn.classList.add('is-loading');
    var originalText = btn.textContent;
    btn.dataset.originalText = originalText;
  }
});

// Auto-dismiss flash messages
(function() {
  var flash = document.getElementById('flash-msg');
  if (flash) {
    setTimeout(function() { flash.remove(); }, 5000);
  }
})();

// Bulk action checkboxes
(function() {
  var selectAll = document.getElementById('select-all');
  var bulkBar = document.getElementById('bulk-bar');
  var bulkCount = document.getElementById('bulk-count');
  if (!selectAll || !bulkBar) return;

  function updateBulkBar() {
    var checked = document.querySelectorAll('.row-check:checked');
    bulkBar.style.display = checked.length > 0 ? 'flex' : 'none';
    if (bulkCount) bulkCount.textContent = checked.length;
  }

  selectAll.addEventListener('change', function() {
    document.querySelectorAll('.row-check').forEach(function(cb) {
      cb.checked = selectAll.checked;
    });
    updateBulkBar();
  });

  document.querySelectorAll('.row-check').forEach(function(cb) {
    cb.addEventListener('change', updateBulkBar);
  });
})();

// Keyboard shortcuts on invoice list: j/k to navigate rows
(function() {
  var table = document.querySelector('.data-table');
  if (!table) return;
  var rows = Array.from(table.querySelectorAll('tbody tr'));
  var currentRow = -1;

  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentRow < rows.length - 1) currentRow++;
      rows.forEach(function(r) { r.style.background = ''; });
      rows[currentRow].style.background = 'var(--bk-accent-light)';
      rows[currentRow].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentRow > 0) currentRow--;
      rows.forEach(function(r) { r.style.background = ''; });
      rows[currentRow].style.background = 'var(--bk-accent-light)';
      rows[currentRow].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && currentRow >= 0) {
      rows[currentRow].click();
    }
  });
})();

// Line item management for invoice review form

function addLine() {
  const container = document.getElementById('line-items');
  if (!container) return;

  // Clone options from existing dropdowns (server-rendered, safe)
  const glOptions = getClonedOptions('line_gl_account');
  const vatOptions = getClonedOptions('line_vat_code');

  const fieldset = document.createElement('fieldset');
  fieldset.className = 'line-item';

  // Build DOM safely without innerHTML
  const row1 = createGrid([
    createLabeledInput('Description', 'text', 'line_description', ''),
    createLabeledNumberInput('Amount', 'line_amount', ''),
  ]);

  const glLabel = document.createElement('label');
  glLabel.textContent = 'GL Account';
  const glSelect = document.createElement('select');
  glSelect.name = 'line_gl_account';
  glOptions.forEach(opt => glSelect.appendChild(opt));
  glLabel.appendChild(glSelect);

  const vatLabel = document.createElement('label');
  vatLabel.textContent = 'VAT Code';
  const vatSelect = document.createElement('select');
  vatSelect.name = 'line_vat_code';
  vatOptions.forEach(opt => vatSelect.appendChild(opt));
  vatLabel.appendChild(vatSelect);

  const removeLabel = document.createElement('label');
  removeLabel.innerHTML = '&nbsp;';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'outline secondary remove-line';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', function() { removeLine(this); });
  removeLabel.appendChild(removeBtn);

  const row2 = createGrid([glLabel, vatLabel, removeLabel]);

  fieldset.appendChild(row1);
  fieldset.appendChild(row2);
  container.appendChild(fieldset);
  recalcTotal();
}

function createGrid(children) {
  const div = document.createElement('div');
  div.className = 'grid';
  children.forEach(c => div.appendChild(c));
  return div;
}

function createLabeledInput(labelText, type, name, value) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.name = name;
  input.value = value;
  label.appendChild(input);
  return label;
}

function createLabeledNumberInput(labelText, name, value) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.01';
  input.name = name;
  input.value = value;
  input.className = 'line-amount';
  label.appendChild(input);
  return label;
}

function getClonedOptions(selectName) {
  const existing = document.querySelector('select[name="' + selectName + '"]');
  if (!existing) return [];
  return Array.from(existing.options).map(opt => {
    const clone = document.createElement('option');
    clone.value = opt.value;
    clone.textContent = opt.textContent;
    return clone;
  });
}

function removeLine(btn) {
  const fieldset = btn.closest('.line-item');
  if (fieldset) {
    fieldset.remove();
    recalcTotal();
  }
}

function recalcTotal() {
  const amounts = document.querySelectorAll('.line-amount');
  let sum = 0;
  amounts.forEach(function(input) {
    sum += parseFloat(input.value) || 0;
  });
  const subtotalEl = document.getElementById('subtotal');
  if (subtotalEl && !subtotalEl.dataset.manual) {
    subtotalEl.value = sum ? sum.toFixed(2) : '';
  }
}

// Auto-recalculate on line amount changes
document.addEventListener('input', function(e) {
  if (e.target.classList.contains('line-amount')) {
    recalcTotal();
  }
});

// Auto-fill GL account and VAT code when supplier changes
(function() {
  const supplierSelect = document.querySelector('select[name="supplier_id"]');
  if (!supplierSelect) return;

  async function loadSupplierDefaults(supplierId) {
    if (!supplierId) return;

    try {
      const res = await fetch('/invoices/api/supplier-defaults/' + supplierId);
      const defaults = await res.json();

      // Set GL account and VAT code on all line items
      if (defaults.gl_account) {
        document.querySelectorAll('select[name="line_gl_account"]').forEach(function(sel) {
          if (!sel.value) sel.value = defaults.gl_account;
        });
      }
      if (defaults.vat_code) {
        document.querySelectorAll('select[name="line_vat_code"]').forEach(function(sel) {
          if (!sel.value) sel.value = defaults.vat_code;
        });
      }

      // Calculate VAT amount from subtotal if we have a percentage
      if (defaults.vat_percentage != null) {
        var subtotalEl = document.getElementById('subtotal');
        var vatEl = document.getElementById('vat_amount');
        var totalEl = document.getElementById('total_amount');
        var subtotal = parseFloat(subtotalEl && subtotalEl.value) || 0;
        var total = parseFloat(totalEl && totalEl.value) || 0;

        if (subtotal && vatEl && !vatEl.value) {
          vatEl.value = (subtotal * defaults.vat_percentage).toFixed(2);
        } else if (total && !subtotal && subtotalEl && vatEl) {
          // Calculate subtotal and VAT from total
          var sub = total / (1 + defaults.vat_percentage);
          subtotalEl.value = sub.toFixed(2);
          vatEl.value = (total - sub).toFixed(2);
        }
      }
    } catch (e) {
      console.error('Failed to load supplier defaults:', e);
    }
  }

  supplierSelect.addEventListener('change', function() {
    loadSupplierDefaults(this.value);
  });

  // Trigger on page load if supplier is already selected and fields are empty
  if (supplierSelect.value) {
    var vatEl = document.getElementById('vat_amount');
    var glSel = document.querySelector('select[name="line_gl_account"]');
    if ((!vatEl || !vatEl.value) || (!glSel || !glSel.value)) {
      loadSupplierDefaults(supplierSelect.value);
    }
  }
})();

// Create supplier from review page
function createSupplier() {
  var name = document.getElementById('new-supplier-name');
  if (!name || !name.value.trim()) { alert('Supplier name is required'); return; }

  var form = document.createElement('form');
  form.method = 'POST';
  form.action = '/invoices/create-supplier';

  var csrf = document.querySelector('input[name="_csrf"]');
  var invoiceId = window.location.pathname.split('/')[2];

  var fields = {
    _csrf: csrf ? csrf.value : '',
    invoice_id: invoiceId,
    supplier_name: name.value.trim(),
    supplier_vat_number: (document.getElementById('new-supplier-vat-number') || {}).value || '',
    supplier_kvk: (document.getElementById('new-supplier-kvk') || {}).value || '',
    supplier_payment_condition: (document.getElementById('new-supplier-payment-condition') || {}).value || '',
    supplier_address: (document.getElementById('new-supplier-address') || {}).value || '',
    supplier_postcode: (document.getElementById('new-supplier-postcode') || {}).value || '',
    supplier_city: (document.getElementById('new-supplier-city') || {}).value || '',
    supplier_country: (document.getElementById('new-supplier-country') || {}).value || '',
    supplier_gl_account: (document.getElementById('new-supplier-gl') || {}).value || '',
    supplier_vat_code: (document.getElementById('new-supplier-vat') || {}).value || '',
  };

  for (var key in fields) {
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = key;
    input.value = fields[key];
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

// Searchable select: enhance select[data-searchable]
(function() {
  document.querySelectorAll('select[data-searchable]').forEach(function(select) {
    var options = Array.from(select.options).map(function(opt) {
      return { value: opt.value, text: opt.textContent };
    });

    // Hide the original select
    select.style.display = 'none';

    // Build wrapper
    var wrapper = document.createElement('div');
    wrapper.className = 'searchable-select';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    // Search input
    var input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search supplier...';
    input.autocomplete = 'off';
    // Show current selection
    var current = select.options[select.selectedIndex];
    if (current && current.value) input.value = current.text;
    wrapper.insertBefore(input, select);

    // Dropdown
    var dropdown = document.createElement('div');
    dropdown.className = 'ss-dropdown';
    wrapper.appendChild(dropdown);

    var activeIdx = -1;

    function clearDropdown() {
      while (dropdown.firstChild) dropdown.removeChild(dropdown.firstChild);
    }

    function render(filter) {
      clearDropdown();
      activeIdx = -1;
      var filtered = options.filter(function(o) {
        if (!o.value) return false;
        return o.text.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
      });
      if (filtered.length === 0) {
        var noRes = document.createElement('div');
        noRes.className = 'ss-no-results';
        noRes.textContent = filter ? 'No results' : 'Type to search...';
        dropdown.appendChild(noRes);
        return;
      }
      filtered.forEach(function(o) {
        var div = document.createElement('div');
        div.className = 'ss-option';
        div.textContent = o.text;
        div.dataset.value = o.value;
        div.addEventListener('mousedown', function(e) {
          e.preventDefault();
          pick(o);
        });
        dropdown.appendChild(div);
      });
    }

    function pick(o) {
      select.value = o.value;
      input.value = o.text;
      wrapper.classList.remove('open');
      select.dispatchEvent(new Event('change'));
    }

    function open() {
      wrapper.classList.add('open');
      render(input.value);
    }

    input.addEventListener('focus', function() {
      input.select();
      open();
    });

    input.addEventListener('input', function() {
      if (!wrapper.classList.contains('open')) open();
      render(input.value);
    });

    input.addEventListener('blur', function() {
      wrapper.classList.remove('open');
      // Restore display text if nothing was picked
      var cur = select.options[select.selectedIndex];
      if (cur && cur.value) input.value = cur.text;
      else input.value = '';
    });

    input.addEventListener('keydown', function(e) {
      var items = dropdown.querySelectorAll('.ss-option');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (activeIdx < items.length - 1) activeIdx++;
        items.forEach(function(el, i) { el.classList.toggle('active', i === activeIdx); });
        if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (activeIdx > 0) activeIdx--;
        items.forEach(function(el, i) { el.classList.toggle('active', i === activeIdx); });
        if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) {
          var val = items[activeIdx].dataset.value;
          var match = options.find(function(o) { return o.value === val; });
          if (match) pick(match);
        }
      } else if (e.key === 'Escape') {
        wrapper.classList.remove('open');
        input.blur();
      }
    });
  });
})();
