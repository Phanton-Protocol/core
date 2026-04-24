import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Building2, 
  Building, 
  User, 
  Wallet, 
  ArrowRightLeft, 
  ShieldCheck, 
  FileText,
  Plus,
  Coins,
  Link as LinkIcon,
  Search,
  Database
} from 'lucide-react';

/**
 * Mock data for the banking hierarchy
 */
const INITIAL_DATA = {
  id: 'state-bank-001',
  name: 'Central State Bank',
  type: 'state',
  note: 'SB-LEDGER-001-ENCRYPTED-A92B',
  banks: [
    {
      id: 'bank-alpha',
      name: 'Alpha Global Bank',
      type: 'bank',
      wallet: '0xBankAlpha...7a12',
      note: 'BANK-ALPHA-LEDGER-V1',
      branches: [
        {
          id: 'branch-north-01',
          name: 'Northern Metropolitan Branch',
          type: 'branch',
          note: 'BRANCH-NORTH-01-LEDGER',
          users: [
            { id: 'u1', name: 'User 001', balance: '1.25 BTC', note: 'USER-001-NOTE-SHIELDED' },
            { id: 'u2', name: 'User 002', balance: '15.0 ETH', note: 'USER-002-NOTE-SHIELDED' },
          ]
        },
        {
          id: 'branch-east-02',
          name: 'East Coast Hub',
          type: 'branch',
          note: 'BRANCH-EAST-02-LEDGER',
          users: [
            { id: 'u3', name: 'User 003', balance: '500 USDT', note: 'USER-003-NOTE-SHIELDED' },
          ]
        }
      ]
    },
    {
      id: 'bank-sigma',
      name: 'Sigma Institutional',
      type: 'bank',
      wallet: '0xBankSigma...f391',
      note: 'BANK-SIGMA-LEDGER-V1',
      branches: [
        {
          id: 'branch-west-01',
          name: 'Western Trade Center',
          type: 'branch',
          note: 'BRANCH-WEST-01-LEDGER',
          users: [
            { id: 'u4', name: 'User 004', balance: '0.5 BTC', note: 'USER-004-NOTE-SHIELDED' },
          ]
        }
      ]
    }
  ]
};

const StateBankVisualizer = () => {
  const [data, setData] = useState(INITIAL_DATA);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processStep, setProcessStep] = useState(0);
  const [processType, setProcessType] = useState('deposit'); // 'deposit', 'withdraw', 'transfer'
  const [mockCreate2Addr, setMockCreate2Addr] = useState('');
  const [auditMode, setAuditMode] = useState(false);
  const [transferTarget, setTransferTarget] = useState(null);

  // CREATE2 Simulation
  const handleSimulateDeposit = (user) => {
    setProcessType('deposit');
    setIsProcessing(true);
    setProcessStep(1);
    
    setTimeout(() => {
      const salt = Math.random().toString(16).slice(2, 10);
      const addr = `0x${salt}a72...${user.id}f9`;
      setMockCreate2Addr(addr);
      setProcessStep(2);
      
      setTimeout(() => {
        setProcessStep(3);
        setTimeout(() => {
          setProcessStep(4);
          setTimeout(() => {
            setIsProcessing(false);
            setProcessStep(0);
            setSelectedEntity(user);
          }, 2000);
        }, 1500);
      }, 1500);
    }, 1000);
  };

  const handleSimulateWithdraw = (user) => {
    setProcessType('withdraw');
    setIsProcessing(true);
    setProcessStep(1);
    
    setTimeout(() => {
      setProcessStep(2); // Shielded proof generation
      setTimeout(() => {
        setProcessStep(3); // Relayer submission
        setTimeout(() => {
          setProcessStep(4); // On-chain settlement
          setTimeout(() => {
            setIsProcessing(false);
            setProcessStep(0);
            setSelectedEntity(user);
          }, 2000);
        }, 1500);
      }, 1500);
    }, 1000);
  };

  const handleSimulateTransfer = (user, target) => {
    setProcessType('transfer');
    setIsProcessing(true);
    setProcessStep(1);
    
    setTimeout(() => {
      setProcessStep(2); // Dual-note update
      setTimeout(() => {
        setProcessStep(3); // Hierarchical sync
        setTimeout(() => {
          setProcessStep(4); // Success
          setTimeout(() => {
            setIsProcessing(false);
            setProcessStep(0);
            setTransferTarget(null);
          }, 2000);
        }, 1500);
      }, 1500);
    }, 1000);
  };

  const renderNote = (note, type) => {
    const isMasked = !auditMode && type !== 'state';
    return (
      <div className={`flex items-center gap-2 mt-2 px-3 py-1.5 rounded border transition-all ${
        auditMode ? 'bg-cyan/10 border-cyan/40' : 'bg-white/5 border-white/10'
      }`}>
        <ShieldCheck className={`w-3 h-3 ${auditMode ? 'text-cyan' : 'text-cyan/60'}`} />
        <span className="font-mono text-[10px] text-cyan uppercase tracking-wider">
          {isMasked ? note.split('-').map((s, i) => i > 0 ? '••••' : s).join('-') : note}
        </span>
      </div>
    );
  };

  return (
    <div className="relative w-full min-h-[750px] bg-[#020202] rounded-2xl border border-white/10 overflow-hidden font-sans">
      {/* Background Grid */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" 
           style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
      
      <div className="relative z-10 p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Hierarchy Tree */}
        <div className="lg:col-span-2 space-y-6">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-2xl font-light text-white">Hierarchical <em className="text-cyan italic">State Bank Pool</em></h2>
              <p className="text-sm text-white/50 mt-1">Institutional privacy layer for national financial graphs.</p>
            </div>
            <div className="flex items-center gap-6">
              <button 
                onClick={() => setAuditMode(!auditMode)}
                className={`flex items-center gap-2 px-4 py-2 rounded-full border transition-all text-[10px] font-mono uppercase tracking-widest ${
                  auditMode 
                    ? 'bg-cyan text-black border-cyan font-bold shadow-[0_0_15px_rgba(0,229,199,0.3)]' 
                    : 'bg-white/5 text-white/40 border-white/10 hover:border-cyan/50'
                }`}
              >
                <Search className="w-3 h-3" />
                {auditMode ? 'Audit Mode: Active' : 'View Key: Masked'}
              </button>
              <div className="flex items-center gap-2 text-[10px] font-mono uppercase text-white/40">
                <div className="w-2 h-2 rounded-full bg-cyan shadow-[0_0_8px_rgba(158,164,170,0.8)]" />
                Live Sync
              </div>
            </div>
          </div>

          {/* State Bank Node */}
          <motion.div 
            layout
            className="p-6 rounded-xl border border-cyan/30 bg-cyan/5 relative group cursor-pointer"
            onClick={() => setSelectedEntity(data)}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-lg bg-cyan/20 border border-cyan/40">
                  <Building2 className="w-6 h-6 text-cyan" />
                </div>
                <div>
                  <h3 className="text-lg font-medium text-white">{data.name}</h3>
                  <div className="text-xs text-white/40 font-mono">Master Ledger Pool (National)</div>
                  {renderNote(data.note, 'state')}
                </div>
              </div>
              <Database className="w-5 h-5 text-cyan/40 group-hover:text-cyan transition-colors" />
            </div>

            {/* Banks Grid */}
            <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.banks.map(bank => (
                <motion.div 
                  key={bank.id}
                  whileHover={{ scale: 1.02 }}
                  className="p-4 rounded-lg border border-white/10 bg-white/5 cursor-pointer hover:border-cyan/50 transition-all"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedEntity(bank);
                  }}
                >
                  <div className="flex items-center gap-3 mb-4">
                    <Building className="w-5 h-5 text-cyan" />
                    <div>
                      <div className="text-sm font-medium text-white">{bank.name}</div>
                      <div className="text-[10px] font-mono text-white/30">{bank.wallet}</div>
                    </div>
                  </div>
                  
                  {/* Branches nested in Bank */}
                  <div className="space-y-2">
                    {bank.branches.map(branch => (
                      <div 
                        key={branch.id}
                        className="p-2 rounded bg-white/5 border border-white/5 hover:border-cyan/30 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEntity(branch);
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Plus className="w-3 h-3 text-cyan/60" />
                            <span className="text-[11px] text-white/70">{branch.name}</span>
                          </div>
                          <div className="text-[9px] font-mono text-white/30">{branch.users.length} Users</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>

        {/* Details Panel */}
        <div className="lg:col-span-1">
          <AnimatePresence mode="wait">
            {!selectedEntity ? (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="h-full flex flex-col items-center justify-center p-8 border border-white/10 rounded-xl bg-white/[0.02] text-center"
              >
                <Search className="w-12 h-12 text-white/10 mb-4" />
                <h4 className="text-white/60 font-medium">Select an entity</h4>
                <p className="text-sm text-white/30 mt-2">Click on a bank, branch, or user to view encrypted ledger details and operations.</p>
              </motion.div>
            ) : (
              <motion.div 
                key={selectedEntity.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="p-6 border border-cyan/20 rounded-xl bg-cyan/[0.03] space-y-6"
              >
                <div className="flex items-center justify-between">
                  <div className="mono text-[10px] text-cyan uppercase tracking-widest">{selectedEntity.type} Details</div>
                  <button onClick={() => {
                    setSelectedEntity(null);
                    setTransferTarget(null);
                  }} className="text-white/20 hover:text-white transition-colors">✕</button>
                </div>

                <div>
                  <h3 className="text-xl font-medium text-white">{selectedEntity.name}</h3>
                  <div className="text-xs text-white/40 mt-1 font-mono">ID: {selectedEntity.id}</div>
                </div>

                <div className="p-4 rounded-lg bg-black/40 border border-white/10 space-y-4">
                  <div>
                    <div className="text-[10px] uppercase text-white/40 mb-2 font-mono flex items-center gap-2">
                      <FileText className="w-3 h-3" /> Encrypted Ledger (Note)
                    </div>
                    {renderNote(selectedEntity.note, selectedEntity.type)}
                  </div>

                  {(selectedEntity.type === 'branch' || selectedEntity.type === 'user') && (
                    <div>
                      <div className="text-[10px] uppercase text-white/40 mb-2 font-mono flex items-center gap-2">
                        <User className="w-3 h-3" /> 
                        {selectedEntity.type === 'branch' ? 'Branch Users' : 'Account Stats'}
                      </div>
                      <div className="space-y-2">
                        {selectedEntity.type === 'branch' ? (
                          selectedEntity.users.map(user => (
                            <div 
                              key={user.id} 
                              className="flex items-center justify-between p-2 rounded bg-white/5 border border-white/5 hover:border-cyan/30 cursor-pointer group"
                              onClick={() => setSelectedEntity(user)}
                            >
                              <div>
                                <div className="text-xs text-white/90">{user.name}</div>
                                <div className="text-[9px] text-white/40 font-mono">{user.balance}</div>
                              </div>
                              <ArrowRightLeft className="w-3 h-3 text-cyan/40 group-hover:text-cyan transition-colors" />
                            </div>
                          ))
                        ) : (
                          <div className="p-3 rounded bg-white/5 border border-white/5">
                            <div className="flex justify-between items-center mb-1">
                              <span className="text-[10px] text-white/30 uppercase">Balance</span>
                              <span className="text-sm text-cyan font-mono">{selectedEntity.balance}</span>
                            </div>
                            <div className="flex justify-between items-center">
                              <span className="text-[10px] text-white/30 uppercase">Status</span>
                              <span className="text-[10px] text-green-400 font-mono uppercase">Verified</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {selectedEntity.type === 'user' && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <button 
                        onClick={() => handleSimulateDeposit(selectedEntity)}
                        disabled={isProcessing}
                        className="py-3 rounded-lg bg-cyan text-black font-bold uppercase tracking-wider text-[10px] flex items-center justify-center gap-2 hover:bg-white transition-colors disabled:opacity-50"
                      >
                        <Plus className="w-3 h-3" /> Deposit
                      </button>
                      <button 
                        onClick={() => handleSimulateWithdraw(selectedEntity)}
                        disabled={isProcessing}
                        className="py-3 rounded-lg border border-white/20 text-white font-bold uppercase tracking-wider text-[10px] flex items-center justify-center gap-2 hover:bg-white hover:text-black transition-colors disabled:opacity-50"
                      >
                        <ArrowRightLeft className="w-3 h-3" rotate={90} /> Withdraw
                      </button>
                    </div>
                    
                    {!transferTarget ? (
                      <button 
                        onClick={() => {
                          // Simplified: Target first user in Alpha Bank Northern Branch that isn't self
                          const target = INITIAL_DATA.banks[0].branches[0].users.find(u => u.id !== selectedEntity.id);
                          setTransferTarget(target);
                        }}
                        disabled={isProcessing}
                        className="w-full py-3 rounded-lg bg-white/5 border border-white/10 text-white/60 font-bold uppercase tracking-wider text-[10px] flex items-center justify-center gap-2 hover:border-cyan/50 hover:text-cyan transition-colors"
                      >
                        <ArrowRightLeft className="w-3 h-3" /> Internal Transfer
                      </button>
                    ) : (
                      <div className="p-3 rounded-lg bg-cyan/10 border border-cyan/30 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-cyan uppercase font-mono">Target: {transferTarget.name}</span>
                          <button onClick={() => setTransferTarget(null)} className="text-cyan/40 hover:text-cyan text-xs">✕</button>
                        </div>
                        <button 
                          onClick={() => handleSimulateTransfer(selectedEntity, transferTarget)}
                          className="w-full py-2 rounded bg-cyan text-black font-bold uppercase text-[9px] hover:bg-white transition-colors"
                        >
                          Confirm Shielded Transfer
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="pt-4 border-t border-white/10">
                  <div className="flex items-center gap-2 text-[10px] text-white/40 italic">
                    <LinkIcon className="w-3 h-3" />
                    Linked to National Ledger API v4.2
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Processing Overlay */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-6"
          >
            <div className="max-w-md w-full space-y-8">
              <div className="text-center">
                <div className="w-20 h-20 bg-cyan/10 border border-cyan/30 rounded-full flex items-center justify-center mx-auto mb-6 relative">
                  <motion.div 
                    animate={{ rotate: 360 }}
                    transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
                    className="absolute inset-0 border-2 border-t-cyan border-transparent rounded-full"
                  />
                  {processType === 'deposit' ? <Wallet className="w-10 h-10 text-cyan" /> :
                   processType === 'withdraw' ? <ArrowRightLeft className="w-10 h-10 text-cyan" rotate={90} /> :
                   <ArrowRightLeft className="w-10 h-10 text-cyan" />}
                </div>
                <h3 className="text-2xl font-light text-white uppercase tracking-widest">
                  {processType === 'deposit' ? (
                    processStep === 1 ? 'Generating CREATE2' : 
                    processStep === 2 ? 'Awaiting Funds' :
                    processStep === 3 ? 'Syncing Ledger' : 'Deposit Confirmed'
                  ) : processType === 'withdraw' ? (
                    processStep === 1 ? 'Verifying Proof' : 
                    processStep === 2 ? 'Generating Shielded Tx' :
                    processStep === 3 ? 'Relayer Submission' : 'Withdrawal Complete'
                  ) : (
                    processStep === 1 ? 'Atomic Swap Prep' : 
                    processStep === 2 ? 'Updating Dual Ledgers' :
                    processStep === 3 ? 'Hierarchical Sync' : 'Transfer Successful'
                  )}
                </h3>
              </div>

              <div className="space-y-4">
                {/* Step indicators */}
                {(processType === 'deposit' ? [
                  { step: 1, label: 'Compute Deterministic Address (CREATE2)' },
                  { step: 2, label: 'Transfer Detection on RPC' },
                  { step: 3, label: 'Sync with Bank Hierarchical Ledger' },
                  { step: 4, label: 'Update Shielded Note' }
                ] : processType === 'withdraw' ? [
                  { step: 1, label: 'ZKP Membership Proof Verification' },
                  { step: 2, label: 'Construct Nullifier & Shielded Output' },
                  { step: 3, label: 'Relayer Broadcast to Mainnet' },
                  { step: 4, label: 'On-chain Commitment Update' }
                ] : [
                  { step: 1, label: 'Dual-Note Join-Split Operation' },
                  { step: 2, label: 'Update Source & Target Ledgers' },
                  { step: 3, label: 'Reconcile with Branch Master' },
                  { step: 4, label: 'State Bank Level Synchronization' }
                ]).map((s) => (
                  <div key={s.step} className="flex items-center gap-4">
                    <div className={`w-8 h-8 rounded-full border flex items-center justify-center text-xs font-mono transition-colors ${
                      processStep >= s.step ? 'bg-cyan border-cyan text-black' : 'border-white/20 text-white/40'
                    }`}>
                      {processStep > s.step ? '✓' : s.step}
                    </div>
                    <div className={`text-sm font-medium ${processStep >= s.step ? 'text-white' : 'text-white/30'}`}>
                      {s.label}
                    </div>
                  </div>
                ))}
              </div>

              {processType === 'deposit' && processStep >= 2 && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 rounded bg-cyan/5 border border-cyan/20 text-center"
                >
                  <div className="text-[10px] uppercase text-white/40 mb-1 font-mono">Computed CREATE2 Address</div>
                  <div className="text-cyan font-mono text-sm tracking-tighter">{mockCreate2Addr}</div>
                </motion.div>
              )}

              {processStep === 4 && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex justify-center"
                >
                  <div className="flex items-center gap-2 px-4 py-2 bg-green-500/20 border border-green-500/40 rounded-full text-green-400 text-xs font-medium">
                    <ShieldCheck className="w-4 h-4" /> All Ledgers Synchronized
                  </div>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default StateBankVisualizer;
