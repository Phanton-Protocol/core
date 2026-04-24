import React, { Suspense, lazy } from 'react';
import Navbar from './Navbar';
import SeoHead from './SeoHead';
import BankingFlowChart from './BankingFlowChart';
import StateBankVisualizer from './StateBankVisualizer';
import { Code, ArrowRight } from 'lucide-react';

const BankingSystemPage = () => {
  return (
    <div className="min-h-screen bg-[#020202]">
      <SeoHead 
        title="Hierarchical Banking System | Phantom Protocol"
        description="Explore how Phantom Protocol integrates with national state banks through hierarchical encrypted ledgers and CREATE2-based crypto deposits."
        path="/banking-system"
      />
      <Navbar />

      <main className="pt-32 pb-20 px-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-16">
          <div className="flex items-center gap-3 mb-4">
             <div className="px-3 py-1 rounded-full bg-cyan/10 border border-cyan/20 text-cyan text-[10px] font-mono uppercase tracking-widest">
               Institutional Layer
             </div>
             <div className="h-[1px] w-12 bg-white/10" />
          </div>
          <h1 className="text-5xl lg:text-7xl font-light text-white mb-6 leading-tight">
            The <em className="text-cyan italic">State Bank</em> <br />
            Liquidity Pool.
          </h1>
          <p className="text-xl text-white/50 max-w-3xl leading-relaxed">
            A multi-layer banking architecture where every country operates as a master pool, 
            containing nested bank pools, branch ledgers, and user notes—all synchronized via 
            shielded zero-knowledge proofs.
          </p>
        </div>

        {/* Visualizer Section */}
        <div className="mb-12">
          <StateBankVisualizer />
        </div>

        {/* Visual Flowchart */}
        <div className="mb-24">
          <BankingFlowChart />
        </div>

        {/* Integration Specs */}
        <div className="mt-24 p-8 lg:p-12 rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent relative overflow-hidden">
          <div className="absolute top-0 right-0 p-8 opacity-10">
            <Code className="w-32 h-32 text-cyan" />
          </div>
          
          <div className="relative z-10 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-light text-white mb-6">Backend <em className="text-cyan italic">Integration</em></h2>
              <div className="space-y-4">
                <div className="flex items-start gap-4">
                   <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-cyan shadow-[0_0_8px_rgba(158,164,170,1)]" />
                   <p className="text-white/70 text-sm">Real-time webhook triggers for CREATE2 deposit events.</p>
                </div>
                <div className="flex items-start gap-4">
                   <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-cyan shadow-[0_0_8px_rgba(158,164,170,1)]" />
                   <p className="text-white/70 text-sm">Hierarchical View Keys for regulatory compliance and auditing.</p>
                </div>
                <div className="flex items-start gap-4">
                   <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-cyan shadow-[0_0_8px_rgba(158,164,170,1)]" />
                   <p className="text-white/70 text-sm">Automated reconciliation between crypto pools and fiat balances.</p>
                </div>
              </div>
              <div className="mt-8">
                 <button className="px-6 py-3 rounded-lg border border-white/20 text-white/60 hover:border-cyan hover:text-cyan transition-all font-mono text-xs uppercase tracking-widest flex items-center gap-2">
                   View API Documentation <ArrowRight className="w-4 h-4" />
                 </button>
              </div>
            </div>

            <div className="bg-black/60 rounded-xl p-6 font-mono text-[11px] leading-relaxed border border-white/5 shadow-2xl">
              <div className="flex gap-1.5 mb-4">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500/40" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/40" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/40" />
              </div>
              <div className="text-cyan mb-2">// Banking Pool Sync Logic</div>
              <div className="text-white/80">
                <span className="text-purple-400">async function</span> <span className="text-blue-400">syncUserDeposit</span>(userId, amount) {'{'} <br />
                &nbsp;&nbsp;<span className="text-gray-500">/* Compute account address */</span> <br />
                &nbsp;&nbsp;<span className="text-orange-400">const</span> depositAddr = <span className="text-blue-400">deriveCreate2</span>(userId, salt); <br />
                <br />
                &nbsp;&nbsp;<span className="text-orange-400">const</span> proof = <span className="text-purple-400">await</span> phantom.<span className="text-blue-400">generateShieldedNote</span>({'{'} <br />
                &nbsp;&nbsp;&nbsp;&nbsp;owner: userId, <br />
                &nbsp;&nbsp;&nbsp;&nbsp;value: amount, <br />
                &nbsp;&nbsp;&nbsp;&nbsp;parentId: branchId <br />
                &nbsp;&nbsp;{'}'}); <br />
                <br />
                &nbsp;&nbsp;<span className="text-purple-400">return</span> <span className="text-purple-400">await</span> masterPool.<span className="text-blue-400">commitNote</span>(proof); <br />
                {'}'}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer Branding */}
      <footer className="py-20 border-t border-white/5">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-8 opacity-40 grayscale">
          <div className="text-sm font-mono text-white">PHANTOM PROTOCOL / CORE BANKING V1.0</div>
          <div className="flex gap-8 text-[10px] font-mono text-white uppercase tracking-[0.2em]">
            <span>Secured by FHE</span>
            <span>Zero-Knowledge Proofs</span>
            <span>Deterministic Auditing</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default BankingSystemPage;
